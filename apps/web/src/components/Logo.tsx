import iconUrl from '../../../../packages/shared/src/assets/Icon.png';

interface PawnkiIconProps {
  size?: number;
  className?: string;
}

export function PawnkiIcon({ size = 24, className = '' }: PawnkiIconProps) {
  return <img src={iconUrl} width={size} height={size} className={className} alt="" />;
}

interface PawnkiLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  align?: 'center' | 'end';
}

export function PawnkiLogo({ size = 'md', align = 'center' }: PawnkiLogoProps) {
  const iconSizes = { sm: 14, md: 28, lg: 40, xl: 72 };
  const textSizes = { sm: 'text-base', md: 'text-xl', lg: 'text-3xl', xl: 'text-7xl' };
  const gaps = { sm: 'gap-1.5', md: 'gap-2', lg: 'gap-3', xl: 'gap-5' };

  return (
    <div className={`flex ${align === 'end' ? 'items-end' : 'items-center'} ${gaps[size]}`}>
      <PawnkiIcon size={iconSizes[size]} />
      <span className={`${textSizes[size]} font-bold tracking-tight leading-none`}>
        <span className="text-accent">Pawn</span>
        <span className="text-gold">ki</span>
      </span>
    </div>
  );
}
