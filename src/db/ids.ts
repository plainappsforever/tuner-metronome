/** Random text id for user rows (not a secret; collisions are practically impossible at this scale). */
export function newId(now = Date.now()): string {
  let rand = '';
  for (let i = 0; i < 3; i++) rand += Math.floor(Math.random() * 2 ** 32).toString(36).padStart(7, '0');
  return `${now.toString(36)}-${rand}`;
}
