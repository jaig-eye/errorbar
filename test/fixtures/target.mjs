// A stand-in for a user's RAG pipeline, speaking errorbar's JSON-lines protocol.
import { createInterface } from 'node:readline';

console.log('a stray line that is not JSON and must be ignored');

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const q = String(request.vars.q ?? '');

  if (q === 'crash') process.exit(3);
  if (q === 'hang') continue;
  if (q === 'fail') {
    console.log(JSON.stringify({ id: request.id, error: 'boom' }));
    continue;
  }

  console.error(`handled ${request.case_id}`);
  console.log(
    JSON.stringify({
      id: request.id,
      output: q.toUpperCase(),
      contexts: [
        { id: 'a', text: 'Document A' },
        { id: 'b', text: 'Document B' },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
      model: 'fixture-1',
    }),
  );
}
