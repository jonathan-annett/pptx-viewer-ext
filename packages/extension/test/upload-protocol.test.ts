// Tests for the server→client protocol validators in src/upload/uploadProtocol.ts.
//
// Mirrors the layout of dropbox-server's test/protocol.test.js, but inverted:
// the server's suite validates the inbound `request`/`cancel` messages it
// receives; this one validates every outbound message the extension might
// receive back. Together the two suites pin down both ends of the wire
// without needing a shared schema dependency.
//
// Run with: npm run test:upload-protocol

import {
  parseServerFrame,
  validateServerMessage,
  type CodeMessage,
  type UploadProgressMessage,
  type UploadStartMessage,
  type UploadEndMessage,
} from '../src/upload/uploadProtocol';

const tests: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push([name, fn]);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ─── fixtures ───────────────────────────────────────────────────────────

const goodCode = (): CodeMessage => ({
  type: 'code',
  code: 'ABCDE',
  url: 'https://vscode.sophtwhere.com/dropbox/ABCDE',
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><path/></svg>',
  expiresAt: '2026-05-23T10:25:00.000Z',
});

const goodProgress = (): UploadProgressMessage => ({
  type: 'upload-progress',
  bytesReceived: 131072,
  sizeBytes: 1048576,
});

const goodStart = (): UploadStartMessage => ({
  type: 'upload-start',
  filename: 'myfile.pptx',
  mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  sizeBytes: 137000000,
});

const goodEnd = (): UploadEndMessage => ({
  type: 'upload-end',
  sha256: 'a'.repeat(64),
});

// ─── tests: top-level dispatch ──────────────────────────────────────────

test('rejects non-object messages', () => {
  assert(validateServerMessage(null).ok === false, 'null');
  assert(validateServerMessage('hi').ok === false, 'string');
  assert(validateServerMessage(42).ok === false, 'number');
  assert(validateServerMessage([1, 2]).ok === false, 'array');
});

test('rejects missing type', () => {
  const r = validateServerMessage({ code: 'ABCDE' });
  assert(r.ok === false, 'should fail');
  if (!r.ok) assert(/missing "type"/.test(r.error), 'error mentions missing type');
});

test('rejects unknown type', () => {
  const r = validateServerMessage({ type: 'banana' });
  assert(r.ok === false, 'should fail');
  if (!r.ok) assert(/unknown message type/.test(r.error), 'error mentions unknown');
});

// ─── tests: code ────────────────────────────────────────────────────────

test('code: validates a well-formed message', () => {
  const r = validateServerMessage(goodCode());
  assert(r.ok === true, 'should validate');
  if (r.ok) {
    assert(r.value.type === 'code', 'type echoed');
    assert((r.value as CodeMessage).code === 'ABCDE', 'code echoed');
    assert((r.value as CodeMessage).qrSvg.startsWith('<svg'), 'svg preserved');
  }
});

test('code: rejects malformed code field', () => {
  const m: any = goodCode(); m.code = 'abc';   // wrong length + wrong case
  assert(validateServerMessage(m).ok === false, 'short rejected');
  const m2: any = goodCode(); m2.code = 'ABCDU'; // U is excluded from alphabet
  assert(validateServerMessage(m2).ok === false, 'U rejected');
  const m3: any = goodCode(); m3.code = 12345;
  assert(validateServerMessage(m3).ok === false, 'numeric rejected');
});

test('code: rejects empty url', () => {
  const m: any = goodCode(); m.url = '';
  assert(validateServerMessage(m).ok === false, 'empty url rejected');
});

test('code: rejects qrSvg that does not start with <svg', () => {
  const m: any = goodCode(); m.qrSvg = 'data:image/svg+xml;base64,abc';
  assert(validateServerMessage(m).ok === false, 'data url rejected');
  const m2: any = goodCode(); m2.qrSvg = '';
  assert(validateServerMessage(m2).ok === false, 'empty rejected');
});

test('code: rejects unparseable expiresAt', () => {
  const m: any = goodCode(); m.expiresAt = 'not-a-date';
  assert(validateServerMessage(m).ok === false, 'garbage date rejected');
  const m2: any = goodCode(); m2.expiresAt = 12345;
  assert(validateServerMessage(m2).ok === false, 'numeric date rejected');
});

// ─── tests: upload-progress ────────────────────────────────────────────

test('upload-progress: validates a well-formed message', () => {
  const r = validateServerMessage(goodProgress());
  assert(r.ok === true, 'should validate');
  if (r.ok) {
    const v = r.value as UploadProgressMessage;
    assert(v.bytesReceived === 131072, 'bytes echoed');
    assert(v.sizeBytes === 1048576, 'size echoed');
  }
});

test('upload-progress: accepts null sizeBytes', () => {
  const m: any = goodProgress(); m.sizeBytes = null;
  const r = validateServerMessage(m);
  assert(r.ok === true, 'null should validate');
  if (r.ok) {
    const v = r.value as UploadProgressMessage;
    assert(v.sizeBytes === null, 'null preserved');
  }
});

test('upload-progress: normalises missing sizeBytes to null', () => {
  const m: any = { type: 'upload-progress', bytesReceived: 1024 };
  const r = validateServerMessage(m);
  assert(r.ok === true, 'missing sizeBytes treated as null');
  if (r.ok) {
    const v = r.value as UploadProgressMessage;
    assert(v.sizeBytes === null, 'normalised to null');
  }
});

test('upload-progress: rejects negative or non-integer bytesReceived', () => {
  const m: any = goodProgress(); m.bytesReceived = -1;
  assert(validateServerMessage(m).ok === false, 'negative rejected');
  const m2: any = goodProgress(); m2.bytesReceived = 12.5;
  assert(validateServerMessage(m2).ok === false, 'float rejected');
  const m3: any = goodProgress(); m3.bytesReceived = '1024';
  assert(validateServerMessage(m3).ok === false, 'string rejected');
});

test('upload-progress: rejects negative or non-integer sizeBytes', () => {
  const m: any = goodProgress(); m.sizeBytes = -1;
  assert(validateServerMessage(m).ok === false, 'negative rejected');
  const m2: any = goodProgress(); m2.sizeBytes = 12.5;
  assert(validateServerMessage(m2).ok === false, 'float rejected');
});

// ─── tests: upload-start ────────────────────────────────────────────────

test('upload-start: validates a well-formed message', () => {
  const r = validateServerMessage(goodStart());
  assert(r.ok === true, 'should validate');
});

test('upload-start: rejects empty filename', () => {
  const m: any = goodStart(); m.filename = '';
  assert(validateServerMessage(m).ok === false, 'empty filename rejected');
});

test('upload-start: rejects empty mime', () => {
  const m: any = goodStart(); m.mime = '';
  assert(validateServerMessage(m).ok === false, 'empty mime rejected');
});

test('upload-start: rejects negative sizeBytes', () => {
  const m: any = goodStart(); m.sizeBytes = -1;
  assert(validateServerMessage(m).ok === false, 'negative size rejected');
});

// ─── tests: upload-end ──────────────────────────────────────────────────

test('upload-end: validates a well-formed sha256', () => {
  const r = validateServerMessage(goodEnd());
  assert(r.ok === true, 'should validate');
});

test('upload-end: rejects non-hex or wrong-length sha256', () => {
  const m: any = goodEnd(); m.sha256 = 'a'.repeat(63);
  assert(validateServerMessage(m).ok === false, 'short rejected');
  const m2: any = goodEnd(); m2.sha256 = 'A'.repeat(64); // uppercase
  assert(validateServerMessage(m2).ok === false, 'uppercase rejected');
  const m3: any = goodEnd(); m3.sha256 = 'g'.repeat(64);
  assert(validateServerMessage(m3).ok === false, 'non-hex rejected');
});

// ─── tests: expired ─────────────────────────────────────────────────────

test('expired: validates with a 5-char code', () => {
  const r = validateServerMessage({ type: 'expired', code: 'ABCDE' });
  assert(r.ok === true, 'should validate');
});

test('expired: rejects missing or malformed code', () => {
  assert(validateServerMessage({ type: 'expired' }).ok === false, 'no code rejected');
  assert(validateServerMessage({ type: 'expired', code: 'abc' }).ok === false, 'short code rejected');
});

// ─── tests: cancelled ───────────────────────────────────────────────────

test('cancelled: validates with no extra fields', () => {
  const r = validateServerMessage({ type: 'cancelled' });
  assert(r.ok === true, 'should validate');
});

test('cancelled: rejects extra fields', () => {
  const r = validateServerMessage({ type: 'cancelled', code: 'ABCDE' });
  assert(r.ok === false, 'extras rejected');
});

// ─── tests: error ───────────────────────────────────────────────────────

test('error: validates with a non-empty message', () => {
  const r = validateServerMessage({ type: 'error', message: 'bad mime' });
  assert(r.ok === true, 'should validate');
});

test('error: rejects empty or non-string message', () => {
  assert(validateServerMessage({ type: 'error', message: '' }).ok === false, 'empty rejected');
  assert(validateServerMessage({ type: 'error', message: 42 }).ok === false, 'number rejected');
  assert(validateServerMessage({ type: 'error' }).ok === false, 'missing rejected');
});

// ─── tests: parseServerFrame (JSON + validate combined) ─────────────────

test('parseServerFrame: parses valid JSON and validates', () => {
  const r = parseServerFrame(JSON.stringify(goodEnd()));
  assert(r.ok === true, 'should validate');
});

test('parseServerFrame: surfaces JSON parse errors', () => {
  const r = parseServerFrame('{not-json');
  assert(r.ok === false, 'should fail');
  if (!r.ok) assert(/not valid JSON/.test(r.error), 'error mentions JSON');
});

test('parseServerFrame: surfaces validation errors after JSON parse', () => {
  const r = parseServerFrame('{"type":"banana"}');
  assert(r.ok === false, 'should fail');
  if (!r.ok) assert(/unknown message type/.test(r.error), 'error mentions unknown type');
});

// ─── runner ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok: ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${name}`);
      console.log(`    ${(e as Error).message}`);
    }
  }
  if (failed) {
    console.log(`\n${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log('all tests passed');
  }
}

run();
