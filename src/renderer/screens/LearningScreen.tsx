import { ScreenScaffold } from './ScreenScaffold';
import { LearningPanel } from '../components/workspace/LearningPanel';
import { GradCapIcon } from '../components/ui/icons';

export function LearningScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Learning"
      screen="learning"
      layout="wide"
      icon={<GradCapIcon size={14} />}
    >
      <LearningPanel />
    </ScreenScaffold>
  );
}
