import { StateSchema } from '@ahead/contracts';

export function App() {
  return (
    <main>
      <h1>AHEAD</h1>
      <ul>
        {StateSchema.options.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </main>
  );
}
