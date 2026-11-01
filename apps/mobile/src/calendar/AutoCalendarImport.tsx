import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { ApiClient } from '../api/http';
import { operationGuard } from '../api/operationGuard';
import { useMutation } from '../api/useMutation';
import { createScheduleClient, type ScheduleItem } from '../schedule/client';
import { civilDate, monthRange } from '../schedule/dates';
import { createCalendarClient, type Calendar, type CalendarEvent, type CalendarImportInput, type CalendarImportResult } from './client';
import { Text } from '../ui/typography';

export function newCalendarEvents(events: CalendarEvent[], items: ScheduleItem[], accountRef: string, calendarId: string) {
  return events.filter(event => !items.some(item => item.sourceRefs.some(ref => ref.provider === 'google_calendar' &&
    ref.accountRef === accountRef && ref.calendarId === calendarId &&
    (ref.externalEventId === event.id || (!!event.occurrenceKey && ref.occurrenceKey === event.occurrenceKey)))));
}
export function primaryCalendar(calendars: Calendar[]): Calendar | undefined {
  const primary = calendars.filter(calendar => calendar.primary === true);
  return primary.length === 1 ? primary[0] : undefined;
}

export default function AutoCalendarImport({ api, timezone, selectedDate, enabled, refreshVersion, onScheduleChanged }: {
  api: ApiClient; timezone: string; selectedDate: Date; enabled: boolean; refreshVersion: number; onScheduleChanged: () => void;
}) {
  const client = useMemo(() => createCalendarClient(api), [api]);
  const schedule = useMemo(() => createScheduleClient(api), [api]);
  const callback = useRef(onScheduleChanged); callback.current = onScheduleChanged;
  const generation = useRef(0); const preparing = useRef(false); const attempted = useRef(new Set<string>()); const alive = useRef(true);
  const [retry, setRetry] = useState(0);
  const [settled, setSettled] = useState(0);
  const [message, setMessage] = useState('');
  const [selection, setSelection] = useState<{ accountRef: string; calendarId: string } | null>(null);
  const [choices, setChoices] = useState<{ accountRef: string; calendars: Calendar[] } | null>(null);
  const mutation = useMutation<CalendarImportInput, CalendarImportResult>(op => client.importEvents(op), result => {
    setMessage('');
    if (result.items.length) callback.current();
  });
  let period: { from: string; to: string } | undefined;
  try { period = monthRange(civilDate(selectedDate, timezone), timezone); } catch { /* show an error without making requests */ }
  const from = period?.from ?? '', to = period?.to ?? '';
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    if (mutation.state.status === 'success') mutation.reset();
  }, [mutation.state.status]);
  useEffect(() => {
    const current = ++generation.current;
    if (!enabled) { attempted.current.clear(); return; }
    if (mutation.state.status !== 'idle' || preparing.current) return;
    const key = JSON.stringify([from, to, timezone, refreshVersion, retry]);
    if (attempted.current.has(key)) return;
    if (!from || !to) { setMessage('캘린더 시간대를 확인해 주세요.'); return; }
    attempted.current.add(key); preparing.current = true; setMessage('');
    const active = () => alive.current && generation.current === current;
    void (async () => {
      try {
        const connection = await client.connection(); if (!active()) return;
        if (connection.status !== 'available') { setChoices(null); setMessage('Google 캘린더 연결 후 일정을 가져올 수 있습니다.'); return; }
        if (!connection.accountRef) { setChoices(null); setMessage('Google 캘린더 계정 정보를 확인할 수 없습니다.'); return; }
        const calendars = await client.calendars(); if (!active()) return;
        const calendar = selection?.accountRef === connection.accountRef ? calendars.find(item => item.id === selection.calendarId) : primaryCalendar(calendars);
        if (!calendar) {
          setChoices({ accountRef: connection.accountRef, calendars });
          setMessage('자동으로 가져올 캘린더를 선택해 주세요.'); return;
        }
        setChoices(null);
        const [remote, local] = await Promise.all([client.events(calendar.id, from, to), schedule.list({ from, to, timezone, includeUnscheduled: false })]);
        if (!active()) return;
        const missing = newCalendarEvents(remote.events, local.items, connection.accountRef, calendar.id);
        if (missing.length > 100) { setMessage('새 일정이 100개를 넘어 자동으로 가져오지 않았습니다. 캘린더 가져오기에서 직접 선택해 주세요.'); return; }
        if (!missing.length) { setMessage(remote.unsupportedCount ? `일정을 확인했습니다. 지원하지 않는 일정 ${remote.unsupportedCount}개는 제외됐습니다.` : ''); return; }
        if (operationGuard.hasUnresolved()) { setMessage('진행 중인 요청을 확인한 뒤 다시 가져와 주세요.'); return; }
        mutation.submit({ calendarId: calendar.id, from, to, selectedEvents: missing.map(({ id, etag }) => ({ id, etag })), expectedScheduleRevision: local.scheduleRevision,
          expectedAccountRef: connection.accountRef, skipExisting: true });
      } catch { if (active()) setMessage('Google 일정을 확인하지 못했습니다. 다시 시도해 주세요.'); }
      finally {
        preparing.current = false;
        if (!active()) attempted.current.delete(key);
        if (alive.current) setSettled(value => value + 1);
      }
    })();
    return () => { generation.current++; };
  }, [client, schedule, enabled, from, to, timezone, refreshVersion, retry, settled, selection, mutation.state.status]);
  if (!enabled) return null;
  const error = mutation.state.status === 'error' ? mutation.state : null;
  if (!error && !message && !choices) return null;
  return <View>
    <Text accessibilityLiveRegion="polite">{error ? (error.uncertain ? '가져오기 결과를 확인하지 못했습니다. 같은 요청을 다시 확인해 주세요.' : '일정을 가져오지 못했습니다. 다시 확인해 주세요.') : message}</Text>
    {choices?.calendars.map(calendar => <Pressable key={calendar.id} accessibilityRole="button" onPress={() => {
      setSelection({ accountRef: choices.accountRef, calendarId: calendar.id }); setChoices(null); setRetry(value => value + 1);
    }}><Text>{calendar.summary}</Text></Pressable>)}
    {(error || message.includes('다시') || message.includes('확인할 수 없습니다')) && <Pressable accessibilityRole="button" onPress={() => {
      if (error?.uncertain) mutation.retry();
      else { if (error) mutation.reset(); setRetry(value => value + 1); }
    }}><Text>{error?.uncertain ? '같은 요청 다시 확인' : '다시 확인'}</Text></Pressable>}
  </View>;
}
