import { getOrbIconMarkup, type OrbIconId } from "../constants/orbAppearance";
import "./OrbIcon.css";

interface OrbIconProps {
  icon: OrbIconId;
  size?: number;
}

export default function OrbIcon({ icon, size = 34 }: OrbIconProps) {
  return (
    <svg
      className="orb-character"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: getOrbIconMarkup(icon) }}
    />
  );
}
