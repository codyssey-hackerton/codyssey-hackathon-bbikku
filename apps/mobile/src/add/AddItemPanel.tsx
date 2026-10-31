import { useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import type { ApiClient } from '../api/http';
import { useMutation } from '../api/useMutation';
import RoutinesPanel from '../routines/RoutinesPanel';
import type { ScheduleClient, ScheduleCommandInput, ScheduleCommandResult, ScheduleFields, ScheduleItem } from '../schedule/client';
import { civilDate, dayRange } from '../schedule/dates';
import { MutationStatus } from '../schedule/MutationStatus';
import { ScheduleForm } from '../schedule/ScheduleForm';
import { useSchedule } from '../schedule/useSchedule';
import { Text } from '../ui/typography';
import { ActionButton } from '../ui/ActionButton';
import type { FormDraft } from '../chat/client';
import { startWrite } from './startWrite';

export type FormContext = FormDraft;
type Props = {
  api: ApiClient; client: ScheduleClient; timezone: string; selectedDate: Date;
  kind: FormContext['kind']; item?: ScheduleItem;
  onClose: () => void; onScheduleChanged: () => void; onAskDraft?: (context: FormContext) => void;
  pendingDraft?: FormDraft; onDraftHandled?: () => void;
};

export default function AddItemPanel(props: Props) {
  const date = useMemo(() => {
    try {
      const civil = civilDate(props.selectedDate, props.timezone);
      return { key: `${civil.year}-${String(civil.month).padStart(2, '0')}-${String(civil.day).padStart(2, '0')}`, range: dayRange(civil, props.timezone) };
    } catch { return null; }
  }, [props.selectedDate.getTime(), props.timezone]);
  if (!date || (props.item && (props.kind === 'routine' || props.item.kind !== props.kind))) return <><Text accessibilityRole="alert">선택한 날짜 또는 일정 종류를 확인해 주세요.</Text><ActionButton label="돌아가기" onPress={props.onClose} secondary /></>;
  if (props.kind === 'routine') return <RoutinesPanel api={props.api} timezone={props.timezone} selectedDate={date.key}
    visible onBack={props.onClose} onDay={() => {}} onScheduleChanged={props.onScheduleChanged} formOnly
    pendingDraft={props.pendingDraft} onDraftHandled={props.onDraftHandled}
    onAskDraft={props.onAskDraft ? fields => props.onAskDraft?.({ kind: 'routine', fields }) : undefined} />;
  return <ScheduleEditor {...props} kind={props.kind} date={date} />;
}

function ScheduleEditor({ client, timezone, kind, item, date, onClose, onScheduleChanged, onAskDraft, pendingDraft, onDraftHandled }: Props & {
  kind: 'event' | 'task'; date: { key: string; range: { from: string; to: string } };
}) {
  const result = useSchedule(client, { ...date.range, timezone, includeUnscheduled: true });
  const requestClient = useRef<ScheduleClient | null>(null);
  const [guardMessage, setGuardMessage] = useState('');
  const action = useMutation<ScheduleCommandInput, ScheduleCommandResult>(op => requestClient.current!.command(op), () => {
    onScheduleChanged(); onClose();
  });
  const blocked = action.state.status === 'pending' || action.state.status === 'error';
  const stale = !!item && result.status === 'success' && !result.data.items.some(current => current.id === item.id && current.revision === item.revision);
  function save(fields: ScheduleFields) {
    if (blocked || stale || result.status !== 'success') return;
    startWrite(() => {
      const changeId = `change-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const change = item ? { changeId, operation: 'update' as const, targetId: item.id, expectedRevision: item.revision, after: fields }
        : { changeId, operation: 'create' as const, after: fields };
      requestClient.current = client;
      action.submit({ expectedScheduleRevision: result.data.scheduleRevision, changeSet: { changes: [change] } });
    }, setGuardMessage);
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text>선택한 날짜: {date.key}</Text>
    {result.status === 'loading' && <Text>최신 일정을 확인하고 있습니다.</Text>}
    {result.status === 'error' && <><Text accessibilityRole="alert">일정을 확인하지 못했습니다.</Text><ActionButton label="일정 다시 조회" onPress={result.retry} secondary /></>}
    {stale && <Text accessibilityRole="alert">일정이 변경되었거나 선택한 날짜에 없습니다. 최신 일정에서 다시 열어 주세요.</Text>}
    {!!guardMessage && <Text accessibilityRole="alert">{guardMessage}</Text>}
    <ScheduleForm item={item ?? null} timezone={timezone} initialKind={kind} defaultDate={date.key} disabled={blocked || result.status !== 'success' || stale}
      cancelDisabled={action.state.status === 'pending' || (action.state.status === 'error' && action.state.uncertain)}
      onCancel={onClose} onSave={save} onAskDraft={onAskDraft ? fields => onAskDraft({ kind, fields }) : undefined}
      pendingDraft={pendingDraft} onDraftHandled={onDraftHandled} />
    <MutationStatus state={action.state} retry={action.retry} reset={action.reset} refresh={result.retry}
      canRetry={requestClient.current === client} success="일정을 저장했습니다." />
  </ScrollView>;
}

const styles = StyleSheet.create({ content: { padding: 20, paddingBottom: 36 } });
