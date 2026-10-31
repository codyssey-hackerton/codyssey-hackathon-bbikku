import { Image } from 'react-native';

/** The center button supplies the background and accessible label. */
export function PikkuCharacter({ size = 34 }: { size?: number }) {
  return <Image source={require('../../assets/pikku-character/pikku.png')} accessible={false}
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants" resizeMode="contain" style={{ width: size, height: size }} />;
}
