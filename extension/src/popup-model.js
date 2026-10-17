// What the popup says about models: the Model menu's choices, the model behind a batch, and the "Next batch" line.
// Pure functions of the worker's status reply (background.js status()), so they test without a DOM.
import { CHOICES, HAIKU_CHOICE, modelLabel } from './model-config.js';

// Whether a key that can reach Claude Haiku is set (pasted or from setup), capped or not.
export const claudeKeySet = (status) => !!(status?.anthropicKey || status?.hostAnthropicKey || status?.openRouterKey
  || status?.hostOpenRouterKey);

// The Model menu: { value, label, disabled }. Claude Haiku needs an Anthropic or OpenRouter key; without one it is
// listed but can't be picked, and says why.
export function modelOptions(status) {
  const hasKey = claudeKeySet(status);
  return Object.entries(CHOICES).map(([value, label]) => (value === HAIKU_CHOICE && !hasKey
    ? { value, label: `${label}: needs a key`, disabled: true } : { value, label, disabled: false }));
}

// A note under the menu when the saved choice can't run as picked; '' otherwise.
export function modelNote(status) {
  return status?.config?.settings?.modelChoice === HAIKU_CHOICE && !claudeKeySet(status)
    ? 'Haiku needs an Anthropic or OpenRouter key (Backup and paid keys); Gemini serves until then.' : '';
}

// "Claude Haiku 5.5 low (Anthropic)", "Gemini 3.1 Flash-Lite (backup key)": a served or planned request.
export function servedLabel(r) {
  if (!r?.model) return '';
  const via = r.keyName === 'backup' ? ' (backup key)' : r.provider === 'anthropic' ? ' (Anthropic)'
    : r.provider === 'openrouter' ? ' (OpenRouter)' : '';
  return `${modelLabel(r.model)}${via}`;
}

// The "Next batch" line: which model serves the next batch at the level in effect.
export function nextText(status) {
  const c = status?.config || {};
  const level = `Level ${status?.next?.level || c.level || 1}`;
  if (c.tier === 'local') return `Built-in list (no model), ${level}`;
  if (c.tier !== 'gemini') return 'None until you add a Gemini key';
  if (!status.next) return `No model free right now (limits reached), ${level}`;
  return `${servedLabel(status.next)}, ${level}`;
}
