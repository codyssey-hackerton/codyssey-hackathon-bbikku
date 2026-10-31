import React, { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import DayScreen, { type DayScreenProps } from './DayScreen';

export type HomeScreenProps = Omit<DayScreenProps, 'presentation'>;
export default function HomeScreen(props: HomeScreenProps) {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    if (props.visible === false) return;
    const update = () => setToday(new Date());
    update(); const timer = setInterval(update, 30_000);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') update(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [props.visible]);
  return <DayScreen {...props} selectedDate={today} presentation="home" />;
}
