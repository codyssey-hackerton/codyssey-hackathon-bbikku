type VoiceOption = { optionId: string; label: string };
type Provider = 'twilio' | 'clawops';
type OptionsInput = { actionUrl: string; introduction?: string; options: VoiceOption[]; explanation?: string; provider?: Provider };

function escapeXml(value: string): string {
  if (typeof value !== 'string' || /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) {
    throw new Error('Invalid XML text');
  }
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' };
  return value.replace(/[&<>"'\n\r\t]/g, char => entities[char]);
}

function action(value: string): string {
  if (typeof value !== 'string' || !/^https:\/\/[^/?#]+/i.test(value) || /[\s\\#]|%(?![0-9a-f]{2})/i.test(value)) throw new Error('Invalid HTTPS action URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid HTTPS action URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('Invalid HTTPS action URL');
  return escapeXml(value);
}

function say(text: string, provider: Provider = 'twilio'): string {
  return provider === 'clawops' ? `<Say language="ko">${escapeXml(text)}</Say>`
    : `<Say voice="Google.ko-KR-Standard-A" language="ko-KR">${escapeXml(text)}</Say>`;
}

export function initialVoiceTwiml(actionUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Redirect method="POST">${action(actionUrl)}</Redirect></Response>`;
}

export function earlyRetryTwiml(actionUrl: string, provider: Provider = 'twilio'): string {
  return provider === 'clawops'
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Redirect>${action(actionUrl)}</Redirect></Response>`
    : initialVoiceTwiml(actionUrl);
}

export function optionsVoiceTwiml({ actionUrl, introduction, options, explanation, provider = 'twilio' }: OptionsInput): string {
  const url = action(actionUrl);
  if (!Array.isArray(options) || options.length < 1 || options.length > 9) throw new Error('Expected one to nine options');
  const ids = new Set<string>();
  const choices = options.map((option, index) => {
    if (!option || typeof option.optionId !== 'string' || !option.optionId.trim() || option.optionId.trim() !== option.optionId || ids.has(option.optionId) ||
        typeof option.label !== 'string' || !option.label.trim()) throw new Error('Invalid option');
    ids.add(option.optionId);
    return `${index + 1}번, ${option.label}.`;
  }).join(' ');
  const intro = introduction === undefined ? '' : say(`인공지능 대리 통화입니다. ${introduction}`, provider);
  const details = explanation === undefined ? '' : say(explanation, provider);
  if (provider === 'clawops') return `<?xml version="1.0" encoding="UTF-8"?><Response>${intro}${details}${say(`가능한 시간을 선택해 주세요. ${choices} 해당 번호를 눌러 주세요. 잘 모르시거나 가능한 시간이 없거나 거절하려면 0번을 눌러 주세요.`, provider)}<Gather action="${url}" timeout="5" numDigits="1"/>${say('응답이 없어 담당자가 다시 확인하겠습니다. 감사합니다.', provider)}<Hangup/></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${intro}<Gather input="dtmf speech" language="ko-KR" action="${url}" method="POST" timeout="5" numDigits="1" actionOnEmptyResult="true">${details}${say(`가능한 시간을 선택해 주세요. ${choices} 해당 번호를 누르거나 말씀해 주세요. 잘 모르시거나 가능한 시간이 없거나 거절하려면 0번을 눌러 주세요.`)}</Gather></Response>`;
}

export function confirmVoiceTwiml({ actionUrl, label, provider = 'twilio' }: { actionUrl: string; label: string; provider?: Provider }): string {
  const url = action(actionUrl);
  if (typeof label !== 'string' || !label.trim()) throw new Error('Invalid label');
  if (provider === 'clawops') return `<?xml version="1.0" encoding="UTF-8"?><Response>${say(`선택하신 시간은 ${label}입니다. 이 시간에 명확히 수락하시면 1번을 눌러 주세요. 다른 입력이나 응답이 없으면 확인 후 검토하겠습니다.`, provider)}<Gather action="${url}" timeout="5" numDigits="1"/>${say('응답이 없어 담당자가 다시 확인하겠습니다. 감사합니다.', provider)}<Hangup/></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="dtmf" action="${url}" method="POST" timeout="5" numDigits="1" actionOnEmptyResult="true">${say(`선택하신 시간은 ${label}입니다. 이 시간에 명확히 수락하시면 1번을 눌러 주세요. 다른 입력이나 응답이 없으면 확인 후 검토하겠습니다.`)}</Gather></Response>`;
}

export function finishVoiceTwiml(text: string, provider: Provider = 'twilio'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say(text, provider)}<Hangup/></Response>`;
}
