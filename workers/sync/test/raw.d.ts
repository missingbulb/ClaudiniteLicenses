// Vite serves any file as its text with the ?raw suffix.
declare module "*?raw" {
  const text: string;
  export default text;
}
