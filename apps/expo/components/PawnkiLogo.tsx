import { View, Text, Image } from 'react-native';

const logoSource = require('@/assets/pawnki-logo.png');

const ICON_SIZES = { sm: 20, md: 28, lg: 40, xl: 56 };
const TEXT_SIZES = { sm: 16, md: 20, lg: 30, xl: 48 };
const GAPS = { sm: 6, md: 8, lg: 12, xl: 16 };

interface Props {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  accentColor: string;
  goldColor: string;
}

export function PawnkiLogo({ size = 'md', accentColor, goldColor }: Props) {
  const iconSize = ICON_SIZES[size];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: GAPS[size] }}>
      <Image
        source={logoSource}
        style={{ width: iconSize, height: iconSize }}
        resizeMode="contain"
      />
      <Text style={{ fontSize: TEXT_SIZES[size], fontWeight: 'bold', letterSpacing: -0.5 }}>
        <Text style={{ color: accentColor }}>Pawn</Text>
        <Text style={{ color: goldColor }}>ki</Text>
      </Text>
    </View>
  );
}
