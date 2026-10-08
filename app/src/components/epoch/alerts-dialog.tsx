'use client';
import { useEffect, useState } from 'react';
import { useAlerts } from '@/lib/data/resources';
import { request } from '@/lib/data/client';
import type { AlertPrefs, AlertTestResult, TelegramLink } from '@/lib/data/contracts/Account.types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ConnectWallet } from './connect-wallet';
export function AlertsDialog({
  open,
  onOpenChange,
  signedIn,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  signedIn: boolean;
}) {
  const query = useAlerts(open && signedIn);
  const [prefs, setPrefs] = useState<AlertPrefs | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  useEffect(() => {
    if (query.data) {
      setPrefs(query.data);
      setEmail(query.data.channels.email ?? '');
    }
  }, [query.data]);
  async function save() {
    if (!prefs) return;
    setBusy(true);
    try {
      await request('/v1/me/alerts', {
        method: 'PUT',
        body: JSON.stringify({ ...prefs, channels: { ...prefs.channels, email: email || null } }),
      });
      await query.refetch();
      setMessage('Alert preferences saved.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your alerts</DialogTitle>
          <DialogDescription>Get notified when your validator’s health changes.</DialogDescription>
        </DialogHeader>
        {!signedIn ? (
          <>
            <p className="text-sm text-muted-foreground">Sign in to save alerts for your wallet.</p>
            <ConnectWallet />
          </>
        ) : prefs ? (
          <>
            <div className="space-y-4">
              {(
                [
                  ['offline', 'Validator goes offline'],
                  ['feeUp', 'Commission increases'],
                  ['losingMoney', 'Revenue drops below costs'],
                  ['rewardsLanded', 'Rewards land'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={prefs.rules[key]}
                    onCheckedChange={(value) =>
                      setPrefs({ ...prefs, rules: { ...prefs.rules, [key]: Boolean(value) } })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <label htmlFor="alert-email" className="text-sm">
              Email address
            </label>
            <Input id="alert-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Button disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save preferences'}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await request<TelegramLink>('/v1/me/alerts/telegram-link', { method: 'POST' });
                    setLink(result.url);
                  } catch (e) {
                    setMessage(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Link Telegram
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await request<AlertTestResult>('/v1/me/alerts/test', { method: 'POST' });
                    setMessage(`Email: ${result.email}. Telegram: ${result.telegram}.`);
                  } catch (e) {
                    setMessage(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Send test alert
              </Button>
            </div>
            {link && (
              <a href={link} target="_blank" rel="noreferrer" className="text-primary underline">
                Open Telegram and press Start
              </a>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{query.error?.message || 'Loading your preferences…'}</p>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
