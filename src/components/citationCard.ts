import {
  hasReference,
  openInZotero,
  referenceTitle,
  renderReference,
} from '../state/citations';
import { type NoteId, vault } from '../vault/api';

/**
 * Details of the cited `keys` as `note`'s preview formats them, each with
 * a button opening it in Zotero, or why a key has no entry. The element is
 * returned at once and filled in as entries render.
 */
export function citationCard(note: NoteId, keys: string[]): HTMLElement {
  const card = document.createElement('div');
  card.className = 'citation-card';
  for (const key of keys) card.appendChild(entry(note, key));
  return card;
}

function entry(note: NoteId, key: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'citation-entry';
  const head = document.createElement('div');
  head.className = 'citation-head';
  const name = document.createElement('span');
  name.className = 'citation-key';
  name.textContent = key;
  head.appendChild(name);
  item.appendChild(head);

  if (!hasReference(key)) {
    item.classList.add('unknown');
    const reason = document.createElement('div');
    reason.className = 'citation-reason';
    reason.textContent = 'No reference with this citation key.';
    item.appendChild(reason);
    void vault.zoteroReady().then(ready => {
      reason.textContent = ready
        ? 'Zotero has no item with this citation key.'
        : "No reference with this citation key yet: Zotero isn't running, so it can't be fetched.";
    });
    return item;
  }

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'citation-open';
  open.textContent = 'Open in Zotero';
  open.addEventListener('mousedown', event => event.preventDefault());
  open.addEventListener('click', () => void openInZotero(key));
  head.appendChild(open);

  const body = document.createElement('div');
  body.className = 'citation-body';
  body.textContent = referenceTitle(key) ?? '';
  item.appendChild(body);
  void renderReference(note, key).then(svg => {
    // Our own compiler's SVG, as in the preview.
    if (svg) body.innerHTML = svg;
  });
  return item;
}
