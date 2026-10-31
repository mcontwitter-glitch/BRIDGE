// No sharp in Workers. Recursive mode (default) never needs it; image mode falls back to compact metadata.
export async function shrinkImage() { return null; }
