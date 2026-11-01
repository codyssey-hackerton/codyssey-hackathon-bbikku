import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ApiClient } from '../api/http';
import { ActionButton } from '../ui/ActionButton';
import { Text } from '../ui/typography';
import { colors } from '../ui/theme';
import { createReviewClient, type ReviewDigest } from './client';

type Load = { api: ApiClient; status: 'loading' | 'error' } | { api: ApiClient; status: 'ready'; digests: ReviewDigest[] };

export default function ReviewDigests({ api, visible, refreshVersion, renderProposal }: {
  api: ApiClient; visible: boolean; refreshVersion: number; renderProposal?: (proposalId: string) => ReactNode;
}) {
  const client = useMemo(() => createReviewClient(api), [api]);
  const [load, setLoad] = useState<Load>({ api, status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let active = true, running = false;
    setLoad({ api, status: 'loading' });
    const read = async () => {
      if (!active || running) return;
      running = true;
      try {
        const digests = await client.digests();
        if (active) setLoad({ api, status: 'ready', digests });
      } catch {
        if (active) setLoad({ api, status: 'error' });
      } finally { running = false; }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [api, client, visible, refreshVersion, attempt]);
  if (!visible) return null;
  const current: Load = load.api === api ? load : { api, status: 'loading' };
  if (current.status === 'ready' && !current.digests.length) return null;
  return <View style={styles.container}>
    <Text accessibilityRole="header" style={styles.heading}>브리핑과 회고</Text>
    {current.status === 'loading' && <Text accessibilityLiveRegion="polite">브리핑과 회고를 불러오고 있습니다.</Text>}
    {current.status === 'error' && <><Text accessibilityRole="alert">브리핑과 회고를 불러오지 못했습니다.</Text>
      <ActionButton label="다시 불러오기" onPress={() => setAttempt(value => value + 1)} secondary /></>}
    {current.status === 'ready' && current.digests.slice(0, expanded ? 10 : 2).map(digest => <View key={digest.id} style={styles.card}>
      <Text style={styles.title}>{digest.reason === 'morning_review' ? '아침 브리핑' : '저녁 회고'}</Text>
      <Text style={styles.time}>{new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(digest.createdAt))}</Text>
      <Text style={styles.message}>{digest.message}</Text>
      {!!digest.proposalIds.length && <Text style={styles.time}>제안은 확인하고 승인하기 전까지 적용되지 않습니다.</Text>}
      {renderProposal && digest.proposalIds.map(id => <View key={id}>{renderProposal(id)}</View>)}
    </View>)}
    {current.status === 'ready' && current.digests.length > 2 &&
      <ActionButton label={expanded ? '이전 기록 접기' : '이전 기록 더 보기'} onPress={() => setExpanded(value => !value)} secondary />}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: 10 }, heading: { color: colors.text, fontSize: 17, fontWeight: '700' },
  card: { gap: 8, padding: 14, borderRadius: 14, backgroundColor: colors.surfaceSecondary },
  title: { color: colors.text, fontWeight: '700' }, time: { color: colors.muted, fontSize: 12 },
  message: { color: colors.text, lineHeight: 21 },
});
