import {
	Breakpoint, Handles, InitializedEvent, logger, Logger, LoggingDebugSession, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { basename, dirname, join } from 'path';
import { ansiSeq, StreamCatcher } from './streamCatcher';

interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	stopOnEntry: boolean;
	perlExecutable?: string;
	debug?: boolean;
	cwd?: string;
	args?: string[];
	env?: { [key: string]: string; };
	threaded?: boolean;
	trace?: boolean;
}

interface IFunctionBreakpointData {
	name: string,
	condition: string;
}

interface IBreakpointData {
	line: number,
	id: number,
	condition: string;
}

export class PerlDebugSession extends LoggingDebugSession {
	private static threadId = 1;
	private currentVarRef = 999;
	private currentBreakpointID = 1;

	private _variableHandles = new Handles<'my' | 'our' | 'special'>();
	private childVarsMap = new Map<number, Variable[]>();
	private parentVarsMap = new Map<number, Variable>();
	private breakpointsMap = new Map<string, IBreakpointData[]>();
	private postponedBreakpoints = new Map<string, IBreakpointData[]>();
	private funcBps: IFunctionBreakpointData[] = [];
	private cwd: string = '';

	// the perl cli session
	private _session!: ChildProcess;
	// helper to run commands and parse output
	private streamCatcher: StreamCatcher = new StreamCatcher;
	// max tries to set a breakpoint
	private maxBreakpointTries: number = 10;

	constructor() {
		super('perl-debug.txt');

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	/**
	 * This function is used to send commands to the perl5db-process
	 * and receive the output as an array of strings.
	 */
	private async request(command: string): Promise<string[]> {
		logger.log(`Command: ${command}`);
		return (await this.streamCatcher.request(command));
	}

	/**
	 * This function normalizes paths depending on the OS the debugger is running on.
	 */
	private normalizePathAndCasing(path: string): string {
		if (process.platform === 'win32') {
			const matched = path.match(/(^[a-z])(:\\.*)/);
			if (matched) {
				path = `${matched[1].toUpperCase()}${matched[2]}`;
			}
			return path.replace(/\//g, '\\');
		} else {
			return path.replace(/\\/g, '/');
		}
	}

	/**
	 * Changes the file context inside the perl5db-process.
	 */
	private async changeFileContext(filePath: string): Promise<string | undefined> {
		let formattedPath = filePath
			.replace(/\\{1,2}/g, '/')
			.replace(/^\.\.\/+/g, '');
		let data = (await this.request(`f ${formattedPath}`))[1];
		if (data.match(/^No file matching '.*' is loaded./)) {
			logger.log(`Could not change file context: ${data}`);
			formattedPath = basename(formattedPath);
			data = (await this.request(`f ${formattedPath}`))[1];
			if (data.match(/^No file matching '.*' is loaded./)) {
				logger.log(`Could not change file context: ${data}`);
				return undefined;
			}
		}
		logger.log(`Successfully changed file context to ${formattedPath}: ${data}`);
		return formattedPath;
	}

	/**
	 * Sets breakpoints in a given perl file.
	 */
	private async setBreakpointsInFile(filePath: string, bps: DebugProtocol.SourceBreakpoint[]): Promise<Breakpoint[]> {
		const setBps: Breakpoint[] = [];
		const mapBps: IBreakpointData[] = [];

		for (let i = 0; i < bps.length; i++) {
			let success = false;
			let line = bps[i].line;
			for (let tries = 0; success === false && tries < this.maxBreakpointTries; tries++) {
				const data = (await this.request(`b ${line} ${bps[i].condition}`)).join('');
				if (data.includes('not breakable')) {
					// try again at the next line
					line++;
				} else {
					// a breakable line was found and the breakpoint set
					success = true;
				}
			}
			const bp = new Breakpoint(success, line, undefined, new Source(filePath, filePath));
			bp.setId(this.currentBreakpointID);
			setBps.push(bp);
			// filling the array for the breakpoints map
			mapBps.push({
				id: this.currentBreakpointID,
				line: line,
				condition: bps[i].condition || ''
			});

			this.currentBreakpointID++;
		}

		// save breakpoints inside the map
		this.breakpointsMap.set(this.normalizePathAndCasing(filePath), mapBps);
		// clear postponed breakpoints
		this.postponedBreakpoints.delete(this.normalizePathAndCasing(filePath));

		return setBps;
	}

	/**
	 * Unsets all breakpoints in a given perl file.
	 */
	private async removeBreakpointsInFile(filePath: string) {
		const scriptPath = this.normalizePathAndCasing(filePath);

		const bps = this.breakpointsMap.get(scriptPath);
		if (bps && (await this.changeFileContext(scriptPath))) {
			for (let i = 0; i < bps.length; i++) {
				// remove the breakpoint inside the debugger
				await this.request(`B ${bps[i].line}`);
			}
		}

		this.breakpointsMap.delete(this.normalizePathAndCasing(filePath));
	}

	/**
	 * Checks if the perl5db-runtime is currently active.
	 */
	private isActive(): boolean {
		const type = typeof this.streamCatcher.input;
		if (type !== 'undefined' && this.streamCatcher.input) {
			return true;
		} else {
			return false;
		}
	}

	/**
	 * Builds a variables expression using its parents ID and name.
	 */
	private getExpression(id: number, expression: string): string {
		let lastParent: Variable | undefined = this.childVarsMap.get(id)?.find(e => { return e.name === expression; });
		if (lastParent) {
			let parentVars: Variable[] = [lastParent!];
			let parent: Variable | undefined;
			while ((parent = this.parentVarsMap.get(id)) && lastParent) {
				const childsOfParent = this.childVarsMap.get(id);
				if (parent && childsOfParent!.includes(lastParent)) {
					parentVars.push(parent);
					// we need to store the last parent variable to find the parent of the lastParent
					lastParent = parent;
				}
				id++;
			}
			// Now we can build the expression
			let currentType = parentVars[parentVars.length - 1].value.match(/^(ARRAY|HASH)/)![1];
			for (let i = parentVars.length - 1; i > -1; i--) {
				const parentVar = parentVars[i];
				if (i === parentVars.length - 1) {
					if (parentVar.name.startsWith('$')) {
						// if a nested variable starts with a dollar sign it has to be an object so the arrow is neccesarry
						expression = `${parentVar.name}->`;
					} else if (parentVar.name.match(/^[%|@]/)) {
						// accessing hash and array values requires a dollar sign at the start
						expression = `${parentVar.name.replace(/^[%|@]/, '$')}`;
					} else {
						expression = parentVar.name;
					}
				} else {
					switch (currentType) {
						case 'ARRAY':
							expression = `${expression}[${parentVar.name}]`;
							break;
						case 'HASH':
							expression = `${(expression.endsWith(']') ? `${expression}->` : expression)}{'${parentVar.name}'}`;
							break;
						default:
							logger.error(`Unknown variable type: ${currentType}`);
							break;
					}
					currentType = parentVar.value.match(/(^ARRAY|^HASH|.*)/)![1];
				}
			}
		}
		return expression;
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		response.body = response.body || {};

		response.body.supportsConfigurationDoneRequest = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsDataBreakpoints = true;
		response.body.supportsSetVariable = true;
		response.body.supportsLoadedSourcesRequest = true;
		response.body.supportsFunctionBreakpoints = true;
		response.body.supportsConditionalBreakpoints = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// reset breakpointID and clear maps
		this.currentBreakpointID = 1;
		this.postponedBreakpoints.clear();
		this.breakpointsMap.clear();

		// set cwd
		args.cwd = this.normalizePathAndCasing(args.cwd || dirname(args.program));
		this.cwd = args.cwd;

		// setup logger
		if (args.trace === true) {
			logger.setup(Logger.LogLevel.Log, false);
		} else {
			logger.setup(Logger.LogLevel.Warn, false);
		}

		// start the program in the runtime
		// Spawn perl process and handle errors
		logger.log(`CWD: ${args.cwd}`);
		let env: NodeJS.ProcessEnv = {
			...process.env,
			...args.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			COLUMNS: '80',
			// eslint-disable-next-line @typescript-eslint/naming-convention
			LINES: '25',
			// eslint-disable-next-line @typescript-eslint/naming-convention
			TERM: 'dumb'
		};
		const spawnOptions: SpawnOptions = {
			detached: true,
			cwd: args.cwd,
			env: env
		};

		args.program = this.normalizePathAndCasing(args.program);
		logger.log(`Script: ${args.program}`);
		const commandArgs = [
			(args.threaded === true ? '-dt' : '-d'),
			args.program,
			...args.args || []
		];

		args.perlExecutable = args.perlExecutable || 'perl';
		logger.log(`Perl executable: ${args.perlExecutable}`);
		this._session = spawn(
			args.perlExecutable,
			commandArgs,
			spawnOptions
		);

		this._session.on('error', err => {
			const text = `Couldn not spawn the child process! Command: ${args.perlExecutable}\nCode: ${err.name}\nError: ${err.message}`;
			logger.error(text);
			this.sendEvent(new OutputEvent(text, 'important'));
			this.sendEvent(new TerminatedEvent());
			return;
		});

		this._session.on('exit', code => {
			const text = `Could not start the debugging session! Script may contains errors. Code: ${code}\nError: ${this.streamCatcher.getBuffer().join('\n')}`;
			this.sendEvent(new OutputEvent(text, 'stderr'));
			this.sendEvent(new TerminatedEvent());
			return;
		});

		// send the script output to the debug console
		this._session.stdout!.on('data', (data) => {
			this.sendEvent(new OutputEvent(data.toString().replace(ansiSeq, ''), 'stdout'));
		});

		await this.streamCatcher.launch(
			this._session.stdin!,
			this._session.stderr!
		);

		// does the user want to debug the script or just run it?
		if (args.debug === true || args.debug === undefined) {
			logger.log('Starting debugging');

			// stop when loading a new file and check if we can call continue after the stop
			await this.request('package DB; *DB::postponed = sub { return sub { if ( \'GLOB\' eq ref(\\$_[0]) && $_[0] =~ /<(.*)\\s*$/s) { if ($DB::single == 0) { print STDERR "continue "; } $DB::single = 1; print STDERR "loaded source $1\\n"; } } ; }->(\\\\&DB::postponed)');

			// use PadWalker to list variables in scope and Data::Dumper for accessing variable values
			const lines = await this.request('use PadWalker qw/peek_our peek_my/; use Data::Dumper;');
			if (lines.join().includes('Can\'t locate')) {
				this.sendEvent(new OutputEvent(`Could not load required modules:\n${lines.join('\n')}`, 'important'));
				this.sendEvent(new TerminatedEvent());
				return;
			}

			// set as many breakpoints as early as possible
			for (let scriptPath of this.postponedBreakpoints.keys()) {
				const bps = this.postponedBreakpoints.get(scriptPath);
				const fileChanged = await this.changeFileContext(scriptPath);
				if (bps && fileChanged) {
					await this.setBreakpointsInFile(scriptPath, bps);
				}
			}

			// set function breakpoints
			for (let i = 0; i < this.funcBps.length; i++) {
				const bp = this.funcBps[i];
				const data = (await this.request(`b ${bp.name} ${bp.condition}`))[1];
				if (data.includes('not found')) {
					this.sendEvent(new OutputEvent(`Could not set function breakpoint:\n${data}`, 'important'));
				}
			}

			// stop on entry or continue?
			logger.log(`StopOnEntry: ${args.stopOnEntry}`);
			if (args.stopOnEntry) {
				this.sendEvent(new StoppedEvent('entry', PerlDebugSession.threadId));
			} else {
				await this.continue();
			}
		} else {
			// Just run
			logger.log('Running script');
			await this.continue();
		}

		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		// save breakpoints in memory and either hand them over in the launch request later or set them now if the runtime is active
		const scriptPath = args.source.path as string;
		const argBps = args.breakpoints!;
		this.currentBreakpointID = 1;

		// setting breakpoints is only possible if the runtime is currently active and the script is already loaded
		if (this.isActive() && await this.changeFileContext(scriptPath)) {
			// first we clear all existing breakpoints inside the file
			await this.removeBreakpointsInFile(scriptPath);
			// now we try to set every breakpoint requested
			response.body = {
				breakpoints: await this.setBreakpointsInFile(scriptPath, argBps)
			};
		} else {
			logger.log('Can not set breakpoints. Runtime is not active yet or file not yet loaded');
			// save breakpoints inside the map
			const bps: Breakpoint[] = [];
			const mapBps: IBreakpointData[] = [];
			argBps.forEach(bp => {
				mapBps.push({
					id: this.currentBreakpointID,
					line: bp.line,
					condition: bp.condition || ''
				});

				bps.push(new Breakpoint(true, bp.line, undefined, new Source(scriptPath, scriptPath)));

				this.currentBreakpointID++;
			});
			this.postponedBreakpoints.set(this.normalizePathAndCasing(scriptPath), mapBps);
			response.body = {
				breakpoints: bps
			};
		}

		this.sendResponse(response);
	}

	protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): Promise<void> {
		for (let i = 0; i < args.breakpoints.length; i++) {
			const bp = args.breakpoints[i];
			this.funcBps.push({
				name: bp.name,
				condition: bp.condition || ''
			});

			// this is only possible if the runtime is currently active
			if (this.isActive()) {
				await this.request(`b ${bp.name} ${bp.condition}`);
			} else {
				logger.warn('Can not set function breakpoint. Runtime is not active yet');
			}
		}

		this.sendResponse(response);
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
		// Get only the current ThreadID as the builtin 'E'-Command can break the debugger process
		let thread: Thread;
		const matched = (await this.request('print STDERR threads->self()->tid()'))[1].trim().match(/^(\d+)$/);
		if (matched) {
			thread = new Thread(PerlDebugSession.threadId, `thread ${matched[1]}`);
		} else {
			thread = new Thread(PerlDebugSession.threadId, 'thread 0');
		}
		response.body = {
			threads: [thread]
		};
		this.sendResponse(response);
	}

	private async getStackFrames(): Promise<StackFrame[]> {
		let stackFrames: StackFrame[] = [];
		const stackTrace = /^[@|.]\s=\s(.*)\scalled\sfrom\sfile\s'(.*)'\sline\s(\d+)/;

		const lines = (await this.request('T')).slice(1, -1);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const matched = line.match(stackTrace);
			if (matched) {
				let file = this.normalizePathAndCasing(matched[2]);
				if (file.startsWith('.')) {
					file = join(this.cwd, file);
				}
				const fn = new Source(basename(file), file);
				stackFrames.push(new StackFrame(i, matched[1], fn, +matched[3]));
			}
		}

		return stackFrames;
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		const stackFrames = await this.getStackFrames();

		response.body = {
			stackFrames: stackFrames,
			totalFrames: stackFrames.length
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope('My', this._variableHandles.create('my'), false),
				new Scope('Our', this._variableHandles.create('our'), false),
				new Scope('Specials', this._variableHandles.create('special'), true)
			]
		};
		// clear parsed variables and reset counter
		this.parentVarsMap.clear();
		this.childVarsMap.clear();
		this.currentVarRef = 999;
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		let varNames: string[] = [];
		let parsedVars: Variable[] = [];
		const handle = this._variableHandles.get(args.variablesReference);
		// < 1000 => nested vars
		if (args.variablesReference >= 1000) {
			if (handle === 'my') {
				varNames = (await this.request('print STDERR join ("|", sort(keys( % { PadWalker::peek_my(2); })))'))[1].split('|');
				logger.log(`Varnames: ${varNames.join(', ')}`);
			}
			if (handle === 'our') {
				varNames = (await this.request('print STDERR join ("|", sort(keys( % { PadWalker::peek_our(2); })))'))[1].split('|');
				logger.log(`Varnames: ${varNames.join(', ')}`);
			}
			else if (handle === 'special') {
				varNames = [
					'%ENV',
					'@ARGV',
					'@INC',
					'@F',
					'$SIG',
					'$ARG',
					'$NR',
					'$RS',
					'$OFS',
					'$ORS',
					'$LIST_SEPARATOR',
					'$SUBSCRIPT_SEPARATOR',
					'$FORMAT_FORMFEED',
					'$FORMAT_LINE_BREAK_CHARACTERS',
					'$ACCUMULATOR',
					'$CHILD_ERROR',
					'$ERRNO',
					'$EVAL_ERROR',
					'$PID',
					'$UID',
					'$EUID',
					'$GID',
					'$EGID',
					'$PROGRAM_NAME',
					'$PERL_VERSION',
					'$DEBUGGING',
					'$INPLACE_EDIT',
					'$OSNAME',
					'$PERLDB',
					'$BASETIME',
					'$WARNING',
					'$EXECUTABLE_NAME',
					'$ARGV'
				];
			}
			if (varNames[0] !== '') {
				parsedVars = await this.parseVars(varNames);
			}
		} else {
			// get already parsed vars from map
			const newVars: DebugProtocol.Variable[] | undefined = this.childVarsMap.get(args.variablesReference);
			// build expressions only for the variables which are displayed as it can be kinda costly
			if (newVars) {
				for (let i = 0; i < newVars.length; i++) {
					newVars[i].evaluateName = this.getExpression(args.variablesReference, newVars[i].name);
				}
				parsedVars = parsedVars.concat(newVars);
			}
		}

		response.body = {
			variables: parsedVars
		};

		this.sendResponse(response);
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, request?: DebugProtocol.Request): Promise<void> {
		let varName = args.expression;

		// ensure that a variable is being evaluated
		if (['$', '%', '@'].includes(varName.charAt(0)) === false) {
			response.success = false;
			this.sendResponse(response);
			return;
		}

		if (varName.startsWith('@')) {
			varName = `[${varName}]`;
		} else if (varName.startsWith('%')) {
			varName = `{${varName}}`;
		}

		// get variable value
		const evaledVar: DebugProtocol.Variable = (await this.parseVars([varName]))[0];
		evaledVar.evaluateName = this.getExpression(evaledVar.variablesReference, evaledVar.name);

		try {
			response.body = {
				result: evaledVar.value,
				variablesReference: evaledVar.variablesReference,
			};
		} catch (error) {
			logger.error(`Could not evaluate ${varName}: ${error}`);
			response.success = false;
		}
		this.sendResponse(response);
	}

	private async parseVars(varNames: string[]): Promise<Variable[]> {
		let vs: DebugProtocol.Variable[] = [];
		for (let i = 0; i < varNames.length; i++) {
			let varName = varNames[i];
			if (varName.startsWith('@')) {
				varName = `[${varName}]`;
			} else if (varName.startsWith('%')) {
				varName = `{${varName}}`;
			}

			let varDump = (await this.request(`print STDERR Data::Dumper->new([${varName}], [])->Deepcopy(1)->Sortkeys(1)->Indent(1)->Terse(0)->Trailingcomma(1)->Useqq(1)->Dump()`)).filter(e => { return e !== ''; }).slice(1, -1);
			try {
				while (true) {
					// Continue everytime we reach a breakpoint during this call until we have proper output
					if (varDump[0].match(/^\$VAR1\s=\s.*/)) {
						break;
					} else {
						logger.log('Reached breakpoint while dumping variable');
						// check if we reached the end
						if (varDump.join().includes('Debugged program terminated.')) {
							// ensure that every script output is send to the debug console before closing the session
							await this.request('sleep(.5)');
							this.sendEvent(new TerminatedEvent());
							return [new Variable(varName, '')];
						}
						varDump = (await this.request('c')).filter(e => { return e !== ''; }).slice(1, -1);
					}
				}
			} catch (error) {
				// Log error and continue with parsing the next variable
				logger.error(`Could not parse variable ${varName}: ${varDump.join('\n')}`);
				this.currentVarRef++;
				continue;
			}
			try {
				if (varDump[0]) {
					varDump[0] = varDump[0].replace(/=/, '=>');
					const matched = varDump[0].match(this.isNamedVariable);
					if (matched && varDump.length === 1) {
						vs.push({
							name: varNames[i],
							value: `${matched[2]}`,
							variablesReference: 0,
							evaluateName: varNames[i],
							presentationHint: { kind: 'data' },
							type: 'SCALAR'
						});
					} else {
						this.currentVarRef--;
						const ref = this.currentVarRef;
						await this.parseDumper(varDump.slice(1, -1));
						const matched = varDump[varDump.length - 1].trim().match(this.isVarEnd);
						const type = `${(matched![1] === '}' ? 'HASH' : 'ARRAY')}${(matched![3] ? ` ${matched![3]}` : '')}`;
						const newVar: DebugProtocol.Variable = {
							name: varNames[i],
							value: type,
							variablesReference: ref,
							evaluateName: varNames[i],
							presentationHint: { kind: 'baseClass' }
						};
						if (type.startsWith('HASH')) {
							newVar.namedVariables = this.childVarsMap.get(ref)?.length;
						} else if (type.startsWith('ARRAY')) {
							newVar.indexedVariables = this.childVarsMap.get(ref)?.length;
						}
						vs.push(newVar);
						this.parentVarsMap.set(ref, newVar);
					}
				} else {
					vs.push({
						name: varNames[i],
						value: 'undef',
						variablesReference: 0,
						presentationHint: { kind: 'data' },
						type: 'UNDEF'
					});
				}
			} catch (error: any) {
				logger.error(`Error parsing variable ${varNames[i]}: ${error}`);
				vs.push({
					name: varNames[i],
					value: 'undef',
					variablesReference: 0,
					presentationHint: { kind: 'data' },
					type: 'UNDEF'
				});
			}
		}

		// return all vars
		return vs;
	}

	// Regexp for parsing the output of Data::Dumper
	private isNamedVariable = /"?(.*)"?\s=>?\s(undef|".*"|-?\d+|\[\]|\{\}|bless\(.*\)|sub\s\{.*\}|\\\*\{".*\"}|\\{1,2}\*.*)[,|;]$/;
	private isIndexedVariable = /^(undef|".*"|-?\d+|\[\]|\{\}|bless\(.*\)|sub\s\{.*\})[,|;]/;
	private isNestedHash = /"(.*)"\s=>?\s(bless\(\s)?(\[|\{)/;
	private isNestedArray = /^(bless\(\s*)?(\{|\[)$/;
	private isVarEnd = /^(\}|\]),?(\s?'(.*)'\s\))?[,|;]/;
	// Parse output of Data::Dumper
	private async parseDumper(lines: string[]): Promise<{ parsedLines: number, varType: string, numChildVars: number; }> {
		let cv: DebugProtocol.Variable[] = [];
		let varType = '';
		let arrayIndex = 0;
		const ref = this.currentVarRef;
		this.currentVarRef--;

		let i: number;
		for (i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			let matched = line.match(this.isVarEnd);
			if (matched) {
				varType = `${(matched[1] === '}' ? 'HASH' : 'ARRAY')}${(matched[3] ? ` ${matched[3]}` : '')}`;
				break;
			} else {
				matched = line.match(this.isNamedVariable);
				if (matched) {
					cv.push({
						name: matched[1].replace(/"/, ''),
						value: matched[2],
						variablesReference: 0,
						presentationHint: { kind: 'data' },
						type: 'SCALAR'
					});
					continue;
				}
				matched = line.match(this.isIndexedVariable);
				if (matched) {
					cv.push({
						name: `${arrayIndex}`,
						value: matched[1],
						variablesReference: 0,
						presentationHint: { kind: 'data' },
						type: 'SCALAR'
					});
					arrayIndex++;
					continue;
				}
				matched = line.match(this.isNestedArray);
				if (matched) {
					const newVar: DebugProtocol.Variable = {
						name: `${arrayIndex}`,
						value: '',
						variablesReference: this.currentVarRef,
						presentationHint: { kind: 'innerClass' }
					};
					this.parentVarsMap.set(this.currentVarRef, newVar);
					const parsed = await this.parseDumper(lines.slice(i + 1));
					i += parsed.parsedLines;
					newVar.value = parsed.varType;
					newVar.type = parsed.varType;
					newVar.indexedVariables = parsed.numChildVars;
					cv.push(newVar);
					arrayIndex++;
					continue;
				}
				matched = line.match(this.isNestedHash);
				if (matched) {
					const newVar: DebugProtocol.Variable = {
						name: matched[1],
						value: '',
						variablesReference: this.currentVarRef,
						presentationHint: { kind: 'innerClass' }
					};
					this.parentVarsMap.set(this.currentVarRef, newVar);
					const parsed = await this.parseDumper(lines.slice(i + 1));
					i += parsed.parsedLines;
					newVar.value = parsed.varType;
					newVar.type = parsed.varType;
					newVar.namedVariables = parsed.numChildVars;
					cv.push(newVar);
					continue;
				}
				logger.error(`Unrecognized Data::Dumper line: ${line}`);
				logger.error(`All lines in current variable scope: ${lines.join('\n')}`);
			}
		}
		this.childVarsMap.set(ref, cv);
		return { parsedLines: i + 1, varType: varType, numChildVars: cv.length };
	}

	protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
		const expressionToChange: string = this.getExpression(args.variablesReference, args.name);
		const lines = (await this.request(`${expressionToChange} = ${args.value}`)).filter(e => { return e !== ''; });
		if (lines.slice(1, -1).length > 0) {
			this.sendEvent(new OutputEvent(`Error setting value: ${lines.join(' ')}`, 'important'));
			response.success = false;
		} else {
			const value = (await this.request(`print STDERR Data::Dumper->new([${(expressionToChange.startsWith('@') ? `[${expressionToChange}]` : (expressionToChange.startsWith('%') ? `{${expressionToChange}}` : expressionToChange))}], [])->Useqq(1)->Terse(1)->Dump()`)).slice(1, -1).join(' ');
			response.body = { value: `${value.trim()}` };
		}
		this.sendResponse(response);
	}

	protected async loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request): Promise<void> {
		let sources: Source[] = [];

		const lines = await this.request('foreach my $INCKEY (keys %INC) { print STDERR $INCKEY . "||" . %INC{$INCKEY} . "\\n" }');
		// remove first and last line
		lines.filter(e => { return e !== ''; }).slice(1, -1).forEach(line => {
			const tmp = line.split('||');
			if (tmp.length === 2) {
				sources.push(new Source(tmp[0], tmp[1].replace(/^\.\//, `${this.cwd}/`)));
			}
		});

		response.body = {
			sources: sources
		};

		this.sendResponse(response);
	}

	private async execute(cmd: string): Promise<void> {
		const lines = await this.request(cmd);
		const scriptOutput = lines.slice(1, lines.findIndex(e => { return e.match(/main::.*|Debugged program terminated|loaded source/); }));
		if (scriptOutput.filter(e => { return e !== ''; }).length > 0) {
			this.sendEvent(new OutputEvent(scriptOutput.join('\n'), 'stderr'));
		}
		// check if we reached the end
		if (lines.join().includes('Debugged program terminated.')) {
			// ensure that every script output is send to the debug console before closing the session
			await this.request('sleep(.5)');
			this.sendEvent(new TerminatedEvent());
			return;
		}
		// the reason why the debugger paused the execution
		let reason: string;
		const newSource = lines.find(ln => { return ln.match(/loaded source/); });
		if (newSource) {
			// set breakpoints in newly loaded file
			const matched = newSource.match(/loaded source (.*)/);
			if (matched) {
				let scriptPath = matched[1]!;
				if (scriptPath.match(/^\./)) {
					scriptPath = join(this.cwd, scriptPath);
				}
				scriptPath = this.normalizePathAndCasing(scriptPath);
				const bps = this.postponedBreakpoints.get(scriptPath);
				if (bps) {
					await this.setBreakpointsInFile(scriptPath, bps);
					// check if we already reached a breakpoint at current position
					// this can happen if the breakpoint is located at the first breakable line inside a file
					const currentLine = (await this.getStackFrames())[0].line;
					for (let i = 0; i < bps.length; i++) {
						const bp = bps[i];
						if (bp.line === currentLine) {
							this.sendEvent(new StoppedEvent('breakpoint', PerlDebugSession.threadId));
							return;
						}
					}
				}
			}
			if (newSource.startsWith('continue') && (cmd === 'n' || cmd === 'c')) {
				// just continue if the current command is continue or step over and the debugger allows it
				await this.continue();
				return;
			} else {
				// else we stop on reaching a new source
				reason = 'new source';
			}
		} else {
			if (cmd === 'c') {
				reason = 'breakpoint';
			} else {
				reason = 'step';
			}
		}
		this.sendEvent(new StoppedEvent(reason, PerlDebugSession.threadId));
	}

	private async continue() {
		await this.execute('c');
	}

	private async step() {
		await this.execute('n');
	}

	private async stepIn() {
		await this.execute('s');
	}

	private async stepOut() {
		await this.execute('r');
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
		this.continue();
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
		this.step();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments): void {
		this.stepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments, _request?: DebugProtocol.Request): void {
		this.stepOut();
		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, _args: DebugProtocol.RestartArguments, _request?: DebugProtocol.Request): void {
		this.streamCatcher.destroy();
		this.sendResponse(response);
	}

	protected terminateRequest(response: DebugProtocol.TerminateResponse, _args: DebugProtocol.TerminateArguments, _request?: DebugProtocol.Request): void {
		this.request('q');
		this.streamCatcher.destroy();
		this.sendResponse(response);
	}
}
