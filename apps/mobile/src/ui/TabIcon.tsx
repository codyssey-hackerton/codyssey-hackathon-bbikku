import { Icon } from './Icon';

export function TabIcon({ name, color }: { name: 'chat' | 'calendar' | 'day'; color: string }) {
  return <Icon name={name} size={23} color={color} />;
}
