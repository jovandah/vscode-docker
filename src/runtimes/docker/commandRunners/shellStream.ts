/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as stream from 'stream';
import {
    CommandResponse,
    CommandRunner,
    GeneratorCommandResponse,
    ICommandRunnerFactory,
    Like,
    normalizeCommandResponseLike,
    PromiseCommandResponse,
    StreamingCommandRunner,
    VoidCommandResponse,
} from '../contracts/CommandRunner';
import { CancellationTokenLike } from '../typings/CancellationTokenLike';
import { AccumulatorStream } from '../utils/AccumulatorStream';
import { CancellationError } from '../utils/CancellationError';
import {
    Shell,
    spawnStreamAsync,
    StreamSpawnOptions,
} from '../utils/spawnStreamAsync';

export type ShellStreamCommandRunnerOptions = Omit<StreamSpawnOptions, 'stdOutPipe'> & {
    strict?: boolean;
};

/**
 * A {@link CommandRunnerFactory} that executes commands on a given shell and
 * manages access to the necessary stdio streams
 */
export class ShellStreamCommandRunnerFactory<TOptions extends ShellStreamCommandRunnerOptions> implements ICommandRunnerFactory {
    public constructor(protected readonly options: TOptions) { }

    public getCommandRunner(): CommandRunner {
        return async <T>(commandResponseLike: Like<VoidCommandResponse> | Like<PromiseCommandResponse<T>>) => {
            const commandResponse = await normalizeCommandResponseLike(commandResponseLike);
            const { command, args } = this.getCommandAndArgs(commandResponse);

            throwIfCancellationRequested(this.options.cancellationToken);

            let result: T | undefined;

            let accumulator: AccumulatorStream | undefined;

            try {
                if (commandResponse.parse) {
                    accumulator = new AccumulatorStream();
                }

                await spawnStreamAsync(command, args, { ...this.options, stdOutPipe: accumulator, shell: true });

                throwIfCancellationRequested(this.options.cancellationToken);

                if (accumulator && commandResponse.parse) {
                    const output = await accumulator.getString();
                    throwIfCancellationRequested(this.options.cancellationToken);
                    result = await commandResponse.parse(output, !!this.options.strict);
                }

                throwIfCancellationRequested(this.options.cancellationToken);

                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                return result!;
            } finally {
                accumulator?.destroy();
            }
        };
    }

    public getStreamingCommandRunner(): StreamingCommandRunner {
        return async <T>(commandResponseLike: Like<GeneratorCommandResponse<T>>) => {
            const commandResponse = await normalizeCommandResponseLike(commandResponseLike);
            const { command, args } = this.getCommandAndArgs(commandResponse);

            throwIfCancellationRequested(this.options.cancellationToken);

            const dataStream: stream.PassThrough = new stream.PassThrough();
            const generator = commandResponse.parseStream(dataStream, !!this.options.strict);

            // Unlike above in `getCommandRunner()`, we cannot await the process, because it will (probably) never exit
            // Instead, forward any error it throws through the stream to the generator
            spawnStreamAsync(command, args, { ...this.options, stdOutPipe: dataStream, shell: true })
                .catch(err => dataStream.destroy(err));

            return generator;
        };
    }

    protected getCommandAndArgs(commandResponse: CommandResponse<unknown>): { command: string, args: string[] } {
        return {
            command: commandResponse.command,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            args: Shell.getShellOrDefault(this.options.shellProvider).quote(commandResponse.args),
        };
    }
}

function throwIfCancellationRequested(token?: CancellationTokenLike): void {
    if (token?.isCancellationRequested) {
        throw new CancellationError('Command cancelled', token);
    }
}