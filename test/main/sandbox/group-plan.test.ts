import { describe, expect, it } from 'vitest';
import { defaultPlan, hasCycle, parsePlan, plannerPrompt } from '@main/sandbox/group-plan';

const members = [
  { id: 'a', name: 'Web researcher', description: 'Finds postings' },
  { id: 'b', name: 'Resume Tailor', description: 'Tailors resumes' },
];
const ask = 'find the newest swe internship posted yesterday and tailor my resume for the same';
const reply = (body: unknown): string => `Here you go:\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

describe('group plans', () => {
  it('turns a dependent request into a shared-sandbox plan with an order', () => {
    const plan = parsePlan(reply({
      summary: 'Research first, then tailor.',
      steps: [
        { agent: 'Web researcher', instruction: 'Find the newest SWE internship posted yesterday.', after: [] },
        { agent: 'Resume Tailor', instruction: 'Tailor the resume for the posting the researcher found.', after: ['Web researcher'] },
      ],
    }), members, ask)!;
    expect(plan.mode).toBe('dag');
    expect(plan.steps.map((step) => [step.agentId, step.dependsOn])).toEqual([['a', []], ['b', [0]]]);
    expect(plan.summary).toBe('Research first, then tailor.');
  });

  it('keeps independent parts parallel', () => {
    const plan = parsePlan(reply({ steps: [{ agent: 'Web researcher', instruction: 'x' }, { agent: 'Resume Tailor', instruction: 'y', after: [] }] }), members, ask)!;
    expect(plan.mode).toBe('parallel');
    expect(plan.steps.every((step) => step.dependsOn.length === 0)).toBe(true);
  });

  it('accepts a bare JSON reply and agent ids, and still runs members the planner left out', () => {
    const plan = parsePlan(JSON.stringify({ steps: [{ agent: 'b', instruction: 'Tailor', after: ['a'] }] }), members, ask)!;
    expect(plan.steps.map((step) => step.agentId)).toEqual(['b', 'a']);
    expect(plan.steps[0]!.dependsOn).toEqual([1]);
    expect(plan.steps[1]!.instruction).toBe(ask);
  });

  it('refuses plans it cannot trust', () => {
    expect(parsePlan('I think they should work together.', members, ask)).toBeNull();
    expect(parsePlan(reply({ steps: [{ agent: 'Nobody', instruction: 'x' }] }), members, ask)).toBeNull();
    // A loop can never start.
    expect(parsePlan(reply({ steps: [{ agent: 'a', after: ['b'] }, { agent: 'b', after: ['a'] }] }), members, ask)).toBeNull();
    // An agent depending on itself, or twice in the plan, is tidied rather than trusted blindly.
    const tidy = parsePlan(reply({ steps: [{ agent: 'a', after: ['a'] }, { agent: 'a', instruction: 'again' }, { agent: 'b' }] }), members, ask)!;
    expect(tidy.steps).toHaveLength(2);
    expect(tidy.mode).toBe('parallel');
  });

  it('finds loops', () => {
    expect(hasCycle([[1], [2], [0]])).toBe(true);
    expect(hasCycle([[], [0], [0, 1]])).toBe(false);
  });

  it('has a default of everyone at once, and a prompt that names the members and the request', () => {
    const plan = defaultPlan(members, ask);
    expect(plan.mode).toBe('parallel');
    expect(plan.steps).toHaveLength(2);
    const prompt = plannerPrompt({ text: ask, members });
    expect(prompt).toContain('Web researcher: Finds postings');
    expect(prompt).toContain(ask);
    expect(prompt).toContain('share one sandbox');
  });
});
