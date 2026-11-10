// The profile screen once onboarded: the same form, editable at any time, also while disabled (FR-010, FR-038).
import { ProfileForm } from "./ProfileForm.js";

export const Profile = () => <ProfileForm step={false} />;
