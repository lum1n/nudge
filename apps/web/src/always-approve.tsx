import { m } from "./i18n/index.ts";

/** Approves and leaves a standing rule; the title says what the rule covers. */
export function AlwaysApproveButton({
  rule,
  disabled,
  onClick,
}: {
  rule: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const title = m.room.approvals.alwaysApproveTitle(rule);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded border border-emerald-700 px-2 py-0.5 text-emerald-800 disabled:opacity-50"
    >
      {m.room.approvals.alwaysApprove}
    </button>
  );
}
