const fail = code => Object.assign(new Error(code), { code });

// One-time invitation codes never enter argv, shell history, environment,
// logs, or echoed terminal output. No prompt runs until explicitly invoked.
export function readHiddenInvitationCode(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.reject(fail('interactive_terminal_required'));
  return new Promise((resolve, reject) => {
    const previousRaw = !!input.isRaw;
    let value = '';
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      input.off('data', onData); input.off('error', onError);
      input.setRawMode(previousRaw); input.pause(); output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onError = () => finish(fail('terminal_error'));
    const onData = bytes => {
      for (const byte of bytes) {
        if (byte === 3) return finish(fail('cancelled'));
        if (byte === 13 || byte === 10) return finish(/^[A-Za-z0-9_-]{43}$/.test(value) ? null : fail('invalid_invitation'));
        if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
        if (byte >= 32 && byte <= 126 && value.length < 43) value += String.fromCharCode(byte);
      }
    };
    output.write('One-time invitation code (hidden): ');
    input.setRawMode(true); input.resume();
    input.on('data', onData); input.on('error', onError);
  });
}
