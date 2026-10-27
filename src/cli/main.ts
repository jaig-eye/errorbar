import { errorMessage } from '../util/text';
import { main } from './commands';

const io = {
  out: (text: string) => void process.stdout.write(text),
  err: (text: string) => void process.stderr.write(text),
};

main(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    io.err(`errorbar: ${errorMessage(error)}
`);
    process.exitCode = 2;
  },
);
