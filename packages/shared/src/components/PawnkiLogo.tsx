interface PawnkiIconProps {
  size?: number;
  className?: string;
  accentColor?: string;
  accentDimColor?: string;
  goldColor?: string;
}

export function PawnkiIcon({ size = 24, className = '' }: PawnkiIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M14 8C11 5 7 4.5 5 6c-1 .8-.5 2.5 1 3.5 2 1.3 5 1.2 8-1.5z" fill="rgb(var(--color-accent))" opacity="0.8" />
      <path d="M18 8c3-3 7-3.5 9-2 1 .8.5 2.5-1 3.5-2 1.3-5 1.2-8-1.5z" fill="rgb(var(--color-accent))" />
      <path d="M15.5 9v4h1V9z" fill="rgb(var(--color-accent-dim))" />
      <circle cx="16" cy="17" r="5" fill="rgb(var(--color-gold))" />
      <path d="M13 22h6v3H13z" fill="rgb(var(--color-gold))" opacity="0.85" />
      <path d="M11 25h10l2 8H9l2-8z" fill="rgb(var(--color-gold))" opacity="0.9" />
      <rect x="7" y="33" width="18" height="4" rx="1.5" fill="rgb(var(--color-gold))" />
    </svg>
  );
}

interface PawnkiLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  accentColor?: string;
  accentDimColor?: string;
  goldColor?: string;
}

export function PawnkiLogo({ size = 'md' }: PawnkiLogoProps) {
  const iconSizes = { sm: 20, md: 28, lg: 40, xl: 56 };
  const textSizes = { sm: 'text-base', md: 'text-xl', lg: 'text-3xl', xl: 'text-8xl' };
  const gaps = { sm: 'gap-1.5', md: 'gap-2', lg: 'gap-3', xl: 'gap-4' };

  return (
    <div className={`flex items-center ${gaps[size]}`}>
      <PawnkiIcon size={iconSizes[size]} />
      <span className={`${textSizes[size]} font-bold tracking-tight`}>
        <span className="text-accent">Pawn</span>
        <span className="text-gold">ki</span>
      </span>
    </div>
  );
}
