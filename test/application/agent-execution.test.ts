import { describe, expect, it } from 'vitest';
import { buildObjectiveLaunch, responseText } from '@main/adapters/objective-cli-adapter';

describe('agent execution protocol',()=>{
  it('runs Codex non-interactively with workspace scope and no approval bypass',()=>{
    const launch=buildObjectiveLaunch('codex',{objective:'Summarize files',rootPath:'/tmp/workspace',description:'Read project',mode:'read_only'});
    expect(launch.args).toEqual(expect.arrayContaining(['exec','--sandbox','read-only','--cd','/tmp/workspace','--json','-']));
    expect(launch.args!.join(' ')).not.toMatch(/dangerously|bypass/);
    expect(launch.stdin).toContain('Summarize files');
    expect(launch.cwd).toBe('/tmp/workspace');
  });
  it('enables workspace writes only when execution mode requests them',()=>{
    expect(buildObjectiveLaunch('codex',{objective:'Edit file',rootPath:'/tmp',mode:'assisted_execution'}).args).toContain('workspace-write');
  });
  it('extracts final responses rather than treating tool logs as acceptance evidence',()=>{
    const lines=[JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'secret instruction'}}),JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'The project is ready'}})];
    expect(responseText(lines.join('\n'))).toBe('The project is ready');
    expect(responseText(lines[0]!)).toBe('');
  });
});
