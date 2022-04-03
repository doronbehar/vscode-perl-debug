import {
	Breakpoint,
	BreakpointEvent, Handles, InitializedEvent, Logger, logger,
	LoggingDebugSession, OutputEvent, Scope, Source, StackFrame, StoppedEvent, TerminatedEvent, Thread, Variable
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Subject } from 'await-notify';
import { dirname, join } from 'path';
import { PerlRuntimeWrapper } from './perlRuntimeWrapper';

export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;
	debug: boolean;
	stopOnEntry: boolean;
	perlExecutable?: string;
	cwd?: string;
	args?: string[];
	env?: object[];
}

export interface IBreakpointData {
	file: string,
	line: number,
	id: number;
}

export class PerlDebugSession extends LoggingDebugSession {
	private static threadId = 1;
	private currentVarRef = 999;
	private currentBreakpointID = 1;

	private _configurationDone = new Subject();

	private _runtime: PerlRuntimeWrapper;

	private _variableHandles = new Handles<'locals' | 'globals'>();
	private varsMap = new Map<number, Variable[]>();
	private bps: IBreakpointData[] = [];
	private cwd: string = "";

	public constructor() {
		super("perl-debug.txt");

		this._runtime = new PerlRuntimeWrapper();

		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', PerlDebugSession.threadId));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', PerlDebugSession.threadId));
		});
		// TODO: Make wrapper send this event if an exception occurs
		this._runtime.on('stopOnException', (exception: string) => {
			this.sendEvent(new StoppedEvent(`exception(${exception})`, PerlDebugSession.threadId));
			this.sendEvent(
				new StoppedEvent("postfork", PerlDebugSession.threadId)
			);
		});
		this._runtime.on('breakpointValidated', (bp: [boolean, number, number]) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: bp[0], line: bp[1], id: bp[2] } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('breakpointDeleted', (bpId: number) => {
			this.sendEvent(new BreakpointEvent('removed', { id: bpId } as DebugProtocol.Breakpoint));
		});
		this._runtime.on('output', (text: string) => {
			this.sendEvent(new OutputEvent(`${text}`));
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code send setVariable request
		response.body.supportsSetVariable = true;

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

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// clear parsed variables and reset counters
		this.varsMap.clear();
		this.currentVarRef = 999;
		this.currentBreakpointID = 1;

		// set cwd
		this.cwd = args.cwd || dirname(args.program);

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(Logger.LogLevel.Verbose, false);

		// wait 1 second until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		await this._runtime.start(
			args.perlExecutable || 'perl',
			args.program,
			!!args.stopOnEntry,
			args.debug, args.args || [],
			this.bps,
			this.cwd
		);
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		// save breakpoints in memory and hand them over in the launch request later
		const clientLines = args.lines!;

		let bps: Breakpoint[] = [];
		this.currentBreakpointID = 1;
		for (let i = 0; i < clientLines.length; i++) {
			const bp = new Breakpoint(false, clientLines[i], undefined, args.source as Source);
			bp.setId(this.currentBreakpointID);
			this.bps.push({ id: this.currentBreakpointID, line: clientLines[i], file: args.source.path as String } as IBreakpointData);
			bps.push(bp);
			this.currentBreakpointID++;
		}

		// send back the actual breakpoint positions
		response.body = {
			breakpoints: bps
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(PerlDebugSession.threadId, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
		let stackFrames: StackFrame[] = [];

		const lines = await this._runtime.request('T');
		let count = 1;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('@')) {
				// TODO: More detailed parsing of stack frames
				let nm = line.split(' = ')[1];
				nm = nm.split("'")[0];
				let file = line.split("'")[1];
				if (file.includes('./')) {
					file = join(this.cwd, file);
					file = this._runtime.normalizePathAndCasing(file);
				}
				const fn = new Source(file);
				const ln = line.split('line ')[1];
				stackFrames.push(new StackFrame(count, nm, fn, +ln));
				count++;
			}
		}

		response.body = {
			stackFrames: stackFrames,
			totalFrames: stackFrames.length
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Locals", this._variableHandles.create('locals'), false),
				new Scope("Globals", this._variableHandles.create('globals'), true)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {

		response.body = {
			variables: await this.parseVars(args.variablesReference)
		};

		this.sendResponse(response);
	}

	private async parseVars(ref: number): Promise<Variable[]> {
		let vs: Variable[] = [];

		// Get all top level vars
		// 1000 => my
		// 1001 => our
		// 1002 => global
		// < 1000 => nested vars
		if (ref >= 1000) {
			let vars: string[] = [];
			if (ref % 2 === 0) {
				vars = (await this._runtime.request('foreach(sort(keys( % { peek_our(2); }), keys( % { peek_my(2); }))) { print STDERR "$_|"; }'))[1].split('|').filter(e => { return e !== ''; });
			}
			else if (ref % 2 === 1) {
				vars = [
					"@ARGV",
					"@INC",
					"@F",
					"%INC",
					"%ENV",
					"$SIG",
					"$ARG",
					"$NR",
					"$RS",
					"$OFS",
					"$ORS",
					"$LIST_SEPARATOR",
					"$SUBSCRIPT_SEPARATOR",
					"$FORMAT_FORMFEED",
					"$FORMAT_LINE_BREAK_CHARACTERS",
					"$ACCUMULATOR",
					"$CHILD_ERROR",
					"$ERRNO",
					"$EVAL_ERROR",
					"$PID",
					"$UID",
					"$EUID",
					"$GID",
					"$EGID",
					"$PROGRAM_NAME",
					"$PERL_VERSION",
					"$DEBUGGING",
					"$INPLACE_EDIT",
					"$OSNAME",
					"$PERLDB",
					"$BASETIME",
					"$WARNING",
					"$EXECUTABLE_NAME",
					"$ARGV"
				];
			}

			for (let i = 0; i < vars.length; i++) {
				let v = vars[i];
				let command = `print STDERR (split (/\\(/, \\${v}))[0]`;
				const perlType = (await this._runtime.request(command))[1];
				if (perlType === 'REF') {
					// add % sign
					v = `{%${v}}`;
				}
				if (perlType === 'ARRAY' || perlType === 'HASH') {
					// add % sign
					v = `\\${v}`;
				}

				// get variable values as json string
				command = `print STDERR JSON->new()->allow_blessed(1)->convert_blessed(1)->encode(${v})`;
				const json = (await this._runtime.request(command))[1];

				switch (perlType) {
					case 'REF':
						// parent variable
						vs.push(new Variable(vars[i], json, this.currentVarRef));
						// child variables
						this.parseVariableChilds(JSON.parse(json));
						break;
					case 'HASH':
						// parent variable
						vs.push(new Variable(vars[i], json, this.currentVarRef));
						// child variables
						this.parseVariableChilds(JSON.parse(json));
						break;
					case 'ARRAY':
						// parent variable
						const childVars: Array<any> = JSON.parse(json);
						vs.push(new Variable(vars[i], `(${childVars.join(', ')})`, this.currentVarRef));
						// child variables
						let cv: Variable[] = [];
						for (let child in childVars) {
							let value: string;
							// add quotes to strings
							if (isNaN(childVars[child])) {
								value = `"${childVars[child]}"`;
							} else {
								value = `${childVars[child]}`;
							}
							cv.push(new Variable(child, value));
						}
						this.varsMap.set(this.currentVarRef, cv);
						this.currentVarRef--;
						break;
					default:
						// SCALAR
						vs.push(new Variable(vars[i], `${json}`));
						break;
				}
			}
		} else {
			// Get already parsed vars from map
			const newVars = this.varsMap.get(ref);
			if (newVars) {
				vs = vs.concat(newVars);
			}
		}

		// return all vars
		return vs;
	}

	private parseVariableChilds(childs: object) {
		let cv: Variable[] = [];
		const ref = this.currentVarRef;
		this.currentVarRef--;
		for (let child in childs) {
			if (this.isObject(childs[child])) {
				// we have found a new parent
				cv.push(new Variable(`${child}`, `${JSON.stringify(childs[child])}`, this.currentVarRef));
				// call this function recursivly to also parse the childs of a child
				this.parseVariableChilds(childs[child]);
			} else {
				// add child to the list of new childs
				let value: string;
				// add quotes to strings
				if (isNaN(childs[child])) {
					value = `"${childs[child]}"`;
				} else {
					value = `${childs[child]}`;
				}
				cv.push(new Variable(`${child}`, `${value}`));
			}
		}
		this.varsMap.set(ref, cv);
	}

	private isObject(a: any) {
		return (!!a) && (a.constructor === Object);
	};

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		// TODO: Check variable and value type
		this._runtime.request(`${args.name} = ${args.value}`);
		response.body = { value: `${args.value}` };
		this.sendResponse(response);
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
		await this._runtime.continue();
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		await this._runtime.step();
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
		await this._runtime.stepIn();
		this.sendResponse(response);
	}

	protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request): Promise<void> {
		await this._runtime.stepOut();
		this.sendResponse(response);
	}
}
