import type { PolicyMode } from "../api.js";

const NEXT: Record<PolicyMode, PolicyMode> = {
  allow: "disallow",
  disallow: "inherit",
  inherit: "allow",
};

export function TriStateToggle({
  value,
  onChange,
  label,
}: {
  value: PolicyMode;
  onChange: (next: PolicyMode) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`tristate tristate-${value}`}
      aria-label={`toggle ${label}`}
      onClick={() => onChange(NEXT[value])}
    >
      {value}
    </button>
  );
}
