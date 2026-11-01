import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import type { DeviceContext } from '@pikku/domain';
import { getCurrentLocation, type CurrentLocation } from '../location/current-location';
import { ActionButton } from '../ui/ActionButton';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';

export default function ChatDeviceContext({ disabled, onChange }: {
  disabled: boolean; onChange: (value: DeviceContext) => void;
}) {
  const [open, setOpen] = useState(false);
  const [location, setLocation] = useState<CurrentLocation | null>(null);
  const [mode, setMode] = useState<DeviceContext['travelMode']>();
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    onChange({ ...(location ? { currentLocation: location } : {}), ...(mode ? { travelMode: mode } : {}),
      notificationSupport: Platform.OS === 'web' ? 'unsupported' : 'device' });
    if (!location) return;
    const timer = setTimeout(() => { setLocation(null); setNotice('위치 정보가 만료됐어요. 다시 연결하거나 출발지를 적어 주세요.'); },
      Math.max(1, Date.parse(location.capturedAt) + 300_000 - Date.now()));
    return () => clearTimeout(timer);
  }, [location, mode, onChange]);
  async function locate() {
    if (disabled || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setLocating(true); setLocation(null); setNotice('');
    const result = await getCurrentLocation({ signal: controller.signal });
    if (controller.signal.aborted) return;
    pending.current = null; setLocating(false);
    if (result.status === 'available') setLocation(result.location);
    else setNotice(result.status === 'denied' ? '위치 권한이 거부됐어요. 기기 설정에서 허용하거나 출발지를 적어 주세요.' :
      result.status === 'timeout' ? '위치를 확인하는 데 시간이 걸렸어요. 다시 시도하거나 출발지를 적어 주세요.' :
        '현재 위치를 확인할 수 없어요. 기기 위치 설정을 확인하거나 출발지를 적어 주세요.');
  }
  return <View style={styles.container}>
    <ActionButton label={open ? '위치·이동수단 접기' : '위치·이동수단'} secondary onPress={() => setOpen(!open)} disabled={disabled} />
    {open && <>
      <Text style={styles.hint}>현재 위치를 이 대화에 5분간 공유합니다. 경로 조회 시 서버와 카카오에 전달됩니다.</Text>
      <View style={styles.row}>
        <ActionButton label={locating ? '위치 확인 중' : location ? '현재 위치 다시 연결' : '현재 위치 사용'} secondary disabled={disabled || locating} onPress={() => void locate()} />
        {location && <ActionButton label="위치 공유 끄기" secondary disabled={disabled} onPress={() => { setLocation(null); setNotice(''); }} />}
      </View>
      {location && <Text accessibilityLiveRegion="polite" style={styles.hint}>현재 위치가 연결됐어요.</Text>}
      {notice !== '' && <Text accessibilityLiveRegion="polite" style={styles.hint}>{notice}</Text>}
      <Text style={styles.hint}>어떻게 이동하시나요?</Text>
      <View style={styles.row}>
        {([{ id: 'transit', label: '대중교통' }, { id: 'walk', label: '도보' }, { id: 'car', label: '자가용' }] as const).map(option =>
          <ActionButton key={option.id} label={`${option.label}${mode === option.id ? ' 선택됨' : ''}`} secondary={mode !== option.id}
            disabled={disabled} onPress={() => setMode(option.id)} />)}
      </View>
      <Text style={styles.hint}>이동수단을 고른 뒤 채팅을 이어 주세요. 버스·지하철 경로는 대중교통으로 조회해요.</Text>
    </>}
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 8 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 19 } });
