import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { assetVersion } from '../state/workspace';
import { vault } from '../vault/api';
import { withOverlayScrollbar } from './scrollbars';

const TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const typeOf = (path: string) =>
  TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? '';

/** An image from the vault, shown in a tab; reloads when it changes on disk. */
export function AssetView(props: { path: string }) {
  const [url, setUrl] = createSignal<string>();
  const [failed, setFailed] = createSignal(false);
  createEffect(() => {
    const path = props.path;
    assetVersion(path);
    let current = true;
    let made: string | undefined;
    vault
      .readFile(`/${path}`)
      .then(data => {
        if (!current) return;
        made = URL.createObjectURL(new Blob([data], { type: typeOf(path) }));
        setUrl(made);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    onCleanup(() => {
      current = false;
      if (made) URL.revokeObjectURL(made);
    });
  });
  const name = () => props.path.slice(props.path.lastIndexOf('/') + 1);
  return (
    <div class="asset-view" ref={withOverlayScrollbar}>
      <Show
        when={!failed() && url()}
        fallback={
          <Show when={failed()}>
            <p class="pane-message">Can't read {name()}.</p>
          </Show>
        }
      >
        {src => <img src={src()} alt={name()} />}
      </Show>
    </div>
  );
}
