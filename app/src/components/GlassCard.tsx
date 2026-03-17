import type { ReactNode, MouseEventHandler } from "react";

interface Props {
  children: ReactNode;
  className?: string;
  elevated?: boolean;
  onClick?: MouseEventHandler;
  as?: "div" | "button";
}

export default function GlassCard({
  children,
  className = "",
  elevated = false,
  onClick,
  as = "div",
}: Props) {
  const base = elevated ? "glass-elevated" : "glass";
  const cls = `${base} rounded-xl ${className}`;

  if (as === "button") {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {children}
      </button>
    );
  }

  return (
    <div onClick={onClick} className={cls}>
      {children}
    </div>
  );
}
