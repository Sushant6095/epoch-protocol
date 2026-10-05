/**
 * Imported by solami-demo before anything that logs: the demo prints its own lines, so the pipeline's logs drop to
 * warnings unless `--verbose` is passed (winston reads LOG_LEVEL once, when it loads).
 */
if (!process.argv.includes('--verbose')) process.env.LOG_LEVEL = 'warn';

export {};
