import { ResumeCenter } from '../components/resume';
import { ScreenScaffold } from './ScreenScaffold';
import { TaskList } from '../components/workspace/TaskList';

export function ActiveTasksScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Active tasks"
      description="Monitor in-flight tasks, their execution plans, and live agent and tool activity."
    >
      <div className="flex flex-col gap-8">
        <TaskList />
        <ResumeCenter />
      </div>
    </ScreenScaffold>
  );
}
