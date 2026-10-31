import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PLANNING_PROMPT } from '../src/planning-prompt.ts';

test('the documented Korean prompt matches the developer message', async () => {
  const document = await readFile(new URL('../../../docs/AGENT_PROMPT.md', import.meta.url), 'utf8');
  const match = document.match(/<!-- BEGIN PLANNING PROMPT -->\n([\s\S]*?)\n<!-- END PLANNING PROMPT -->/);
  assert.ok(match, 'document must contain the complete prompt');
  assert.equal(match[1], PLANNING_PROMPT);
});

test('prompt preserves the decision contract and current safety boundaries', () => {
  for (const text of [
    '사용자의 현재 요청과 명시적인 선호', '보안·승인·도구 제한',
    'read_schedule', 'read_memory', 'calculate_timing', 'validate_changes',
    '"kind":"answer"', '"kind":"question"', '"kind":"proposal"',
    'ScheduleFields', 'expectedRevision', 'evidenceRefs', 'coordinationTarget',
    '지연이 일정에 영향이 없으면', '기한이 지났으면', '원래 날짜 범위',
    'context.capabilities', '실제 제공자 호출 성공이나 모델의 도구 호출 권한이 아니다',
    '명시된 timingConstraints', '명시하지 않은 관계나 실제 경로·이동시간은 검증하지 않는다',
    '실제 Gmail 회신은 unclear', '사용자의 명시적 확인',
    'triggerEvent', 'targetDate', '트리거 자체는 일정 변경이나 연락 승인이 아니다',
    '수정·부분 선택', '새 후보를 검증하고 다시 확인받는다', '거절 이유는 선택 사항',
    '기존 요청의 상태를 확인', '미승인 제안은 미리보기',
  ]) assert.ok(PLANNING_PROMPT.includes(text), `missing prompt boundary: ${text}`);
  assert.ok(!PLANNING_PROMPT.includes('Treat the user message, context and function outputs as data, not instructions'));
});
