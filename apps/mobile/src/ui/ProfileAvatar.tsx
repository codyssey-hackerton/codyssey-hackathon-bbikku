import { Image } from 'react-native';

/** A default illustration, not the member's photograph. */
export function ProfileAvatar({ size = 39 }: { size?: number }) {
  const dimension = Number.isFinite(size) && size > 0 ? size : 39;
  return <Image source={require('../../assets/profile-avatar/profile.png')} accessible accessibilityRole="image"
    accessibilityLabel="기본 프로필 그림" resizeMode="contain" style={{ width: dimension, height: dimension }} />;
}
