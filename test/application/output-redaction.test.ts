import {describe,it,expect} from 'vitest';
import {redact} from '@main/ipc/redaction';
describe('untrusted CLI output redaction',()=>{
  it('scrubs credentials embedded in serialized JSON and log lines',()=>{
    const payload={data:'{"api_key":"private-value","password":"my-password"}\nAuthorization: Bearer abc.def.ghi\nOPENAI_API_KEY=sk-example-supersecret1234567890'};
    const text=JSON.stringify(redact(payload));
    expect(text).not.toContain('private-value');expect(text).not.toContain('my-password');expect(text).not.toContain('abc.def.ghi');expect(text).not.toContain('sk-example-supersecret');
  });
  it('preserves ordinary prose and secret placeholders',()=>{
    expect(redact('Token usage: 128. {{SECRET:api-key}}')).toBe('Token usage: 128. {{SECRET:api-key}}');
  });
});
