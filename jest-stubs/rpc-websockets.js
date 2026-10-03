// web3.js imports rpc-websockets, which depends on an ESM-only uuid that jest (CommonJS) cannot load. Tests never
// open a websocket through web3.js, so a stand-in is enough. Mapped in jest.config.base.js.
class CommonClient {
  on() {}
  once() {}
  off() {}
  removeListener() {}
  connect() {}
  close() {}
  call() {
    return Promise.reject(new Error('rpc-websockets is stubbed in tests'));
  }
  notify() {
    return Promise.resolve();
  }
}
module.exports = { CommonClient, WebSocket: () => undefined };
