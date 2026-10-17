// What the popup says about models: the Model and Reasoning menus, the Mode line, the model behind a batch, the "Next
// batch" line and the header's version. Pure functions of the worker's status reply (background.js status()), so they
// test without a DOM.
import { CHOICES, HAIKU_CHOICE, modelLabel, reasoningLevels } from './model-config.js';

// Whether a key that can reach Claude Haiku is set (pasted or from setup), capped or not.
export const claudeKeySet = (status) => !!(status?.anthropicKey || status?.hostAnthropicKey || status?.openRouterKey
  || status?.hostOpenRouterKey);

// The Model menu: { value, label, disabled }. Recommended says what it resolves to; Claude Haiku needs an Anthropic
// or OpenRouter key, and without one it is listed but can't be picked, and says why.
export function modelOptions(status) {
  const hasKey = claudeKeySet(status);
  return Object.entries(CHOICES).map(([value, label]) => {
    if (value === 'auto') return { value, label: status?.recommended ? `${label} (${modelLabel(status.recommended.model)})` : label, disabled: false };
    if (value === HAIKU_CHOICE && !hasKey) return { value, label: `${label}: needs a Claude key`, disabled: true };
    return { value, label, disabled: false };
  });
}

// The Reasoning menu for the model the reader chose: Recommended (that model's measured setting), then the levels it
// takes. selected: the saved level when that model takes it, else Recommended.
export function reasoningOptions(status) {
  const levels = reasoningLevels(status?.first);
  const recommended = status?.firstDefault?.thinking;
  const options = [{ value: 'auto', label: recommended ? `Recommended (${recommended})` : 'Recommended' },
    ...levels.map((l) => ({ value: l, label: l }))];
  const saved = status?.config?.settings?.reasoning;
  return { options, selected: levels.includes(saved) ? saved : 'auto' };
}

// A note under the menus when the saved model can't run as picked; '' otherwise.
export function modelNote(status) {
  return status?.config?.settings?.modelChoice === HAIKU_CHOICE && !claudeKeySet(status)
    ? 'Claude Haiku needs a Claude key: an Anthropic key, or an OpenRouter key (Backup and paid keys).' : '';
}

const reasoningText = (thinking) => (!thinking || thinking === 'off' ? 'reasoning off' : `${thinking} reasoning`);

// "Mode: Recommended → Claude Haiku 5.5 · low reasoning · Level 2 (Auto)": the model and reasoning the reader's
// choices come to, and the level in effect, "(Auto)" when it follows the Claude Code stage.
export function modeText(status) {
  const c = status?.config || {};
  const s = c.settings || {};
  const level = `Level ${c.level || 1} (${s.levelOverride ? 'set here' : 'Auto'})`;
  if (c.tier === 'local') return `Mode: built-in list, no model · ${level}`;
  if (c.tier !== 'gemini') return 'Mode: none until you add a Gemini key';
  const first = status.first;
  if (!first) return `Mode: ${level}`;
  const model = s.modelChoice === 'auto' ? `Recommended → ${modelLabel(first.model)}` : modelLabel(first.model);
  return `Mode: ${model} · ${reasoningText(first.thinking)} · ${level}`;
}

// "Claude Haiku 5.5 (Anthropic)", "Gemini 3.1 Flash-Lite (backup key)": a served or planned request.
export function servedLabel(r) {
  if (!r?.model) return '';
  const via = r.keyName === 'backup' ? ' (backup key)' : r.provider === 'anthropic' ? ' (Anthropic)'
    : r.provider === 'openrouter' ? ' (OpenRouter)' : '';
  return `${modelLabel(r.model)}${via}`;
}

// The "Next batch" line: which model serves the next batch at the level in effect, keys, caps and cooldowns counted.
export function nextText(status) {
  const c = status?.config || {};
  const level = `Level ${status?.next?.level || c.level || 1}`;
  if (c.tier === 'local') return `Built-in list (no model), ${level}`;
  if (c.tier !== 'gemini') return 'None until you add a Gemini key';
  if (!status.next) return `No model free right now (limits reached), ${level}`;
  return `${servedLabel(status.next)}, ${level}`;
}

// The header: "0.2.9 · dev build". channel: 'dev' when the plugin came from the dev marketplace (fw_host.py).
export const versionText = (status) => [status?.version, status?.channel && `${status.channel} build`].filter(Boolean).join(' · ');

// The line under the header: an update about to load (the popup then asks for the reload, which closes it), or the
// one that just loaded, shown once.
export function updateText(status) {
  if (status?.updating) return `Updating to ${status.updating}…`;
  if (status?.updated) return `Updated to ${status.updated}`;
  return '';
}
