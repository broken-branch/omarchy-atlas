// Browser tokens live in storage scoped to the exact scheme, host and port.
export const browserToken = () => sessionStorage.getItem('atlas-browser-token') || '';

export function authFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${browserToken()}`);
  return fetch(url, {...options, headers, credentials:'omit'});
}

export function authEvents(url) {
  const listeners = new Map();
  const controller = new AbortController();
  let stopped = false;
  const emit = (name, data = '') => {
    for (const listener of listeners.get(name) || []) listener({data});
  };
  async function connect() {
    while (!stopped) {
      try {
        const response = await authFetch(url, {signal:controller.signal});
        if (!response.ok || !response.body) throw Error(`HTTP ${response.status}`);
        emit('open');
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let pending = '';
        while (!stopped) {
          const {value, done} = await reader.read();
          if (done) break;
          pending += decoder.decode(value, {stream:true}).replace(/\r/g, '');
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, end); pending = pending.slice(end + 2);
            const type = /^event: (.+)$/m.exec(block)?.[1];
            const data = [...block.matchAll(/^data: ?(.*)$/gm)].map(match => match[1]).join('\n');
            if (type) emit(type, data);
          }
        }
      } catch { if (!stopped) emit('error'); }
      if (!stopped) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  connect();
  return {addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) || []), listener]); },
          close() { stopped = true; controller.abort(); }};
}
