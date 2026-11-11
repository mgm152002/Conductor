import { ResumeCenter } from '../components/resume';
import { ScreenScaffold } from './ScreenScaffold';
import { TaskList } from '../components/workspace/TaskList';
import { TicketIcon } from '../components/ui/icons';

export function ActiveTasksScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Active tasks"
      screen="active-tasks"
      layout="dashboard"
      icon={<TicketIcon size={16} />}
    >
      {/* Ops wall: the live ticket feed takes the desk, resumptions wait in a rail. */}
      <div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
        <TaskList />
        <div className="lg:sticky lg:top-5">
          <ResumeCenter />
        </div>
      </div>
    </ScreenScaffold>
  );
}
