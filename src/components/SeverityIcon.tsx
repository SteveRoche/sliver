import CircleX from 'lucide-solid/icons/circle-x';
import TriangleAlert from 'lucide-solid/icons/triangle-exclamation-point';
import { createRoot } from 'solid-js';
import type { Diagnostic } from '../typst/protocol';

type Severity = Diagnostic['severity'];

const ICONS = { error: CircleX, warning: TriangleAlert };

/** An error's or warning's icon, coloured by `.severity-icon.<severity>`. */
export function SeverityIcon(props: { severity: Severity }) {
  const Icon = ICONS[props.severity];
  return (
    <span class={`severity-icon ${props.severity}`}>
      <Icon size={14} aria-label={props.severity} />
    </span>
  );
}

/** One rendered icon per severity, cloned for DOM built outside Solid. */
const templates = new Map<Severity, Element>();

/** The same icon as a DOM node, e.g. for a CodeMirror tooltip. */
export function severityIconNode(severity: Severity): Node {
  let template = templates.get(severity);
  if (!template) {
    const span = document.createElement('span');
    span.className = `severity-icon ${severity}`;
    // The icon is called rather than rendered as JSX, whose result hot
    // reloading wraps in a function in dev (see CLAUDE.md).
    span.appendChild(
      createRoot(dispose => {
        const icon = ICONS[severity]({ size: 14 }) as Element;
        dispose();
        return icon;
      }),
    );
    template = span;
    templates.set(severity, template);
  }
  return template.cloneNode(true);
}
