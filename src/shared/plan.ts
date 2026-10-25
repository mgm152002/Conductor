// Plan mode: a planner agent writes requirements and a task list with
// dependencies; Conductor runs the tasks on agents, independent ones in
// parallel. Shared by main and renderer.

export interface PlanRequirement {
  /** "1", "2", … */
  id: string;
  title: string;
  userStory?: string;
  /** Criterion n of requirement r is referenced as "r.n". */
  acceptanceCriteria: string[];
}

export interface PlanTask {
  /** "<group>.<n>", e.g. "2.3". */
  id: string;
  title: string;
  details: string[];
  /** Requirement ids ("1") or criterion ids ("1.2"). */
  requirements: string[];
  /** Ids of tasks that must finish first. */
  dependsOn: string[];
  /** Agent (adapter id) that runs the task, after validation. */
  agent: string;
  /** How demanding the task is; picks the model and effort on Auto. */
  difficulty: 'simple' | 'moderate' | 'complex';
}

export interface PlanGroup {
  id: string;
  title: string;
  tasks: PlanTask[];
}

export interface AgentPlan {
  title: string;
  introduction: string;
  requirements: PlanRequirement[];
  groups: PlanGroup[];
}

export interface PlanWave {
  id: number;
  tasks: string[];
}

export type TaskPlanStatus = 'requested' | 'planning' | 'ready' | 'failed';

export interface TaskPlanView {
  plannerAdapterId: string;
  status: TaskPlanStatus;
  error?: string;
  /** Absolute folder holding requirements.md and tasks.md. */
  docsDir?: string;
  plan?: AgentPlan;
  waves?: PlanWave[];
  /** Plan task id → task step id. */
  steps?: Record<string, string>;
  /** Model and effort the planner ran with. */
  plannerRun?: { model?: string; effort?: string; source: string };
}
