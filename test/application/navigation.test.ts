import {describe,it,expect} from 'vitest';
import {isApplicationUrl} from '@main/navigation-policy';
describe('renderer navigation boundary',()=>{
  it('allows only the packaged document and its hash routes',()=>{
    expect(isApplicationUrl('file:///app/index.html#/home','file:///app/index.html')).toBe(true);
    expect(isApplicationUrl('file:///etc/passwd','file:///app/index.html')).toBe(false);
  });
  it('compares exact development origins rather than URL prefixes',()=>{
    expect(isApplicationUrl('http://localhost:5173/#/home','http://localhost:5173/')).toBe(true);
    expect(isApplicationUrl('http://localhost:5173.evil.test/','http://localhost:5173/')).toBe(false);
    expect(isApplicationUrl('javascript:alert(1)','http://localhost:5173/')).toBe(false);
  });
});
