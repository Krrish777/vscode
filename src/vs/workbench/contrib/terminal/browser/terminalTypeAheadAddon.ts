/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color } from 'vs/base/common/color';
import { debounce } from 'vs/base/common/decorators';
import { Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { TerminalConfigHelper } from 'vs/workbench/contrib/terminal/browser/terminalConfigHelper';
import { IBeforeProcessDataEvent, ITerminalProcessManager } from 'vs/workbench/contrib/terminal/common/terminal';
import type { IBuffer, IBufferCell, ITerminalAddon, Terminal } from 'xterm';

const ESC = '\x1b';
const CSI = `${ESC}[`;
const SHOW_CURSOR = `${CSI}?25h`;
const HIDE_CURSOR = `${CSI}?25l`;
const DELETE_CHAR = `${CSI}X`;
const DELETE_REST_OF_LINE = `${CSI}K`;
const CSI_STYLE_RE = /^\x1b\[[0-9;]*m/;
const CSI_MOVE_RE = /^\x1b\[([0-9]*)(;[35])?O?([DC])/;
const PASSWORD_INPUT_RE = /(password|passphrase|passwd).*:/i;
const NOT_WORD_RE = /\W/;

const statsBufferSize = 24;
const statsSendTelemetryEvery = 1000 * 60 * 5; // how often to collect stats
const statsMinSamplesToTurnOn = 5;
const statsMinAccuracyToTurnOn = 0.3;
const statsToggleOffThreshold = 0.5; // if latency is less than `threshold * this`, turn off

/**
 * Codes that should be omitted from sending to the prediction engine and
 * insted omitted directly:
 *  - cursor hide/show
 *  - mode set/reset
 */
const PREDICTION_OMIT_RE = /^(\x1b\[\??25[hl])+/;

const enum CursorMoveDirection {
	Back = 'D',
	Forwards = 'C',
}

interface ICoordinate {
	x: number;
	y: number;
	baseY: number;
}

class Cursor implements ICoordinate {
	private _x = 0;
	private _y = 1;
	private _baseY = 1;

	public get x() {
		return this._x;
	}

	public get y() {
		return this._y;
	}

	public get baseY() {
		return this._baseY;
	}

	public get coordinate(): ICoordinate {
		return { x: this._x, y: this._y, baseY: this._baseY };
	}

	constructor(public readonly rows: number, public readonly cols: number, private readonly buffer: IBuffer) {
		this._x = buffer.cursorX;
		this._y = buffer.cursorY;
		this._baseY = buffer.baseY;
	}

	public getCell(loadInto?: IBufferCell) {
		return this.buffer.getLine(this._y + this._baseY)?.getCell(this._x, loadInto);
	}

	public moveTo(coordinate: ICoordinate) {
		this._x = coordinate.x;
		this._y = (coordinate.y + coordinate.baseY) - this._baseY;
		return this.moveInstruction();
	}

	public clone() {
		const c = new Cursor(this.rows, this.cols, this.buffer);
		c.moveTo(this);
		return c;
	}

	public move(x: number, y: number) {
		this._x = x;
		this._y = y;
		return this.moveInstruction();
	}

	public shift(x: number = 0, y: number = 0) {
		this._x += x;
		this._y += y;
		return this.moveInstruction();
	}

	public moveInstruction() {
		if (this._y >= this.rows) {
			this._baseY += this._y - (this.rows - 1);
			this._y = this.rows - 1;
		} else if (this._y < 0) {
			this._baseY -= this._y;
			this._y = 0;
		}

		return `${CSI}${this._y + 1};${this._x + 1}H`;
	}
}

const moveToWordBoundary = (b: IBuffer, cursor: Cursor, direction: -1 | 1) => {
	let ateLeadingWhitespace = false;
	if (direction < 0) {
		cursor.shift(-1);
	}

	let cell: IBufferCell | undefined;
	while (cursor.x >= 0) {
		cell = cursor.getCell(cell);
		if (!cell?.getCode()) {
			return;
		}

		const chars = cell.getChars();
		if (NOT_WORD_RE.test(chars)) {
			if (ateLeadingWhitespace) {
				break;
			}
		} else {
			ateLeadingWhitespace = true;
		}

		cursor.shift(direction);
	}

	if (direction < 0) {
		cursor.shift(1); // we want to place the cursor after the whitespace starting the word
	}
};

const enum MatchResult {
	/** matched successfully */
	Success,
	/** failed to match */
	Failure,
	/** buffer data, it might match in the future one more data comes in */
	Buffer,
}

export interface IPrediction {
	/**
	 * Returns a sequence to apply the prediction.
	 * @param buffer to write to
	 * @param cursor position to write the data. Should advance the cursor.
	 * @returns a string to be written to the user terminal, or optionally a
	 * string for the user terminal and real pty.
	 */
	apply(buffer: IBuffer, cursor: Cursor): string;

	/**
	 * Returns a sequence to roll back a previous `apply()` call. If
	 * `rollForwards` is not given, then this is also called if a prediction
	 * is correct before show the user's data.
	 */
	rollback(cursor: Cursor): string;

	/**
	 * If available, this will be called when the prediction is correct.
	 */
	rollForwards(cursor: Cursor, withInput: string): string;

	/**
	 * Returns whether the given input is one expected by this prediction.
	 */
	matches(input: StringReader): MatchResult;
}

class StringReader {
	public index = 0;

	public get remaining() {
		return this.input.length - this.index;
	}

	public get eof() {
		return this.index === this.input.length;
	}

	public get rest() {
		return this.input.slice(this.index);
	}

	constructor(private readonly input: string) { }

	/**
	 * Advances the reader and returns the character if it matches.
	 */
	public eatChar(char: string) {
		if (this.input[this.index] !== char) {
			return;
		}

		this.index++;
		return char;
	}

	/**
	 * Advances the reader and returns the string if it matches.
	 */
	public eatStr(substr: string) {
		if (this.input.slice(this.index, substr.length) !== substr) {
			return;
		}

		this.index += substr.length;
		return substr;
	}

	/**
	 * Matches and eats the substring character-by-character. If EOF is reached
	 * before the substring is consumed, it will buffer. Index is not moved
	 * if it's not a match.
	 */
	public eatGradually(substr: string): MatchResult {
		let prevIndex = this.index;
		for (let i = 0; i < substr.length; i++) {
			if (i > 0 && this.eof) {
				return MatchResult.Buffer;
			}

			if (!this.eatChar(substr[i])) {
				this.index = prevIndex;
				return MatchResult.Failure;
			}
		}

		return MatchResult.Success;
	}

	/**
	 * Advances the reader and returns the regex if it matches.
	 */
	public eatRe(re: RegExp) {
		const match = re.exec(this.input.slice(this.index));
		if (!match) {
			return;
		}

		this.index += match[0].length;
		return match;
	}

	/**
	 * Advances the reader and returns the character if the code matches.
	 */
	public eatCharCode(min = 0, max = min + 1) {
		const code = this.input.charCodeAt(this.index);
		if (code < min || code >= max) {
			return undefined;
		}

		this.index++;
		return code;
	}
}

/**
 * Preidction which never tests true. Will always discard predictions made
 * after it.
 */
class HardBoundary implements IPrediction {
	public apply() {
		return '';
	}

	public rollback() {
		return '';
	}

	public rollForwards() {
		return '';
	}

	public matches() {
		return MatchResult.Failure;
	}
}

/**
 * Wraps another prediction. Does not apply the prediction, but will pass
 * through its `matches` request.
 */
class TentativeBoundary implements IPrediction {
	private expected?: Cursor;
	constructor(private readonly inner: IPrediction) { }

	public apply(buffer: IBuffer, cursor: Cursor) {
		this.expected = cursor.clone();
		this.inner.apply(buffer, this.expected);
		return '';
	}

	public rollback() {
		return '';
	}

	public rollForwards(cursor: Cursor, withInput: string) {
		if (this.expected) {
			cursor.moveTo(this.expected);
		}

		return withInput;
	}

	public matches(input: StringReader) {
		return this.inner.matches(input);
	}
}

/**
 * Prediction for a single alphanumeric character.
 */
class CharacterPrediction implements IPrediction {
	protected appliedAt?: {
		pos: ICoordinate,
		oldAttributes: string;
		oldChar: string;
	};

	constructor(private readonly style: string, private readonly char: string) { }

	public apply(buffer: IBuffer, cursor: Cursor) {
		const cell = cursor.getCell();
		this.appliedAt = cell
			? { pos: cursor.coordinate, oldAttributes: getBufferCellAttributes(cell), oldChar: cell.getChars() }
			: { pos: cursor.coordinate, oldAttributes: '', oldChar: '' };

		cursor.shift(1);
		return this.style + this.char + this.appliedAt.oldAttributes;
	}

	public rollback(cursor: Cursor) {
		if (!this.appliedAt) {
			return ''; // not applied
		}

		const { oldAttributes, oldChar, pos } = this.appliedAt;
		const r = cursor.moveTo(pos) + (oldChar ? `${oldAttributes}${oldChar}${cursor.moveTo(pos)}` : DELETE_CHAR);
		return r;
	}

	public rollForwards(cursor: Cursor, input: string) {
		if (!this.appliedAt) {
			return ''; // not applied
		}

		return cursor.clone().moveTo(this.appliedAt.pos) + this.appliedAt.oldAttributes + input;
	}

	public matches(input: StringReader) {
		let startIndex = input.index;

		// remove any styling CSI before checking the char
		while (input.eatRe(CSI_STYLE_RE)) { }

		if (input.eof) {
			return MatchResult.Buffer;
		}

		if (input.eatChar(this.char)) {
			return MatchResult.Success;
		}

		input.index = startIndex;
		return MatchResult.Failure;
	}
}

class BackspacePrediction extends CharacterPrediction {
	constructor() {
		super('', '\b');
	}

	public apply(_: IBuffer, cursor: Cursor) {
		const cell = cursor.getCell();
		this.appliedAt = cell
			? { pos: cursor.coordinate, oldAttributes: getBufferCellAttributes(cell), oldChar: cell.getChars() }
			: { pos: cursor.coordinate, oldAttributes: '', oldChar: '' };

		return cursor.shift(-1) + DELETE_CHAR;
	}

	public rollForwards() {
		return '';
	}

	public matches(input: StringReader) {
		const isEOL = this.appliedAt?.oldChar === '';
		if (isEOL) {
			const r1 = input.eatGradually(`\b${CSI}K`);
			if (r1 !== MatchResult.Failure) {
				return r1;
			}

			const r2 = input.eatGradually(`\b \b`);
			if (r2 !== MatchResult.Failure) {
				return r2;
			}
		}

		return MatchResult.Failure;
	}
}

class NewlinePrediction implements IPrediction {
	protected prevPosition?: ICoordinate;

	public apply(_: IBuffer, cursor: Cursor) {
		this.prevPosition = cursor.coordinate;
		cursor.move(0, cursor.y + 1);
		return '\r\n';
	}

	public rollback(cursor: Cursor) {
		return this.prevPosition ? cursor.moveTo(this.prevPosition) : '';
	}

	public rollForwards() {
		return ''; // does not need to rewrite
	}

	public matches(input: StringReader) {
		return input.eatGradually('\r\n');
	}
}

/**
 * Prediction when the cursor reaches the end of the line. Similar to newline
 * prediction, but shells handle it slightly differently.
 */
class LinewrapPrediction extends NewlinePrediction implements IPrediction {
	public apply(_: IBuffer, cursor: Cursor) {
		this.prevPosition = cursor.coordinate;
		cursor.move(0, cursor.y + 1);
		return ' \r';
	}

	public matches(input: StringReader) {
		// bash and zshell add a space which wraps in the terminal, then a CR
		const r = input.eatGradually(' \r');
		if (r !== MatchResult.Failure) {
			// zshell additionally adds a clear line after wrapping to be safe -- eat it
			const r2 = input.eatGradually(DELETE_REST_OF_LINE);
			return r2 === MatchResult.Buffer ? MatchResult.Buffer : r;
		}

		return input.eatGradually('\r\n');
	}
}

class CursorMovePrediction implements IPrediction {
	private applied?: {
		rollForward: string;
		prevPosition: number;
		prevAttrs: string;
		amount: number;
	};

	constructor(
		private readonly direction: CursorMoveDirection,
		private readonly moveByWords: boolean,
		private readonly amount: number,
	) { }

	public apply(buffer: IBuffer, cursor: Cursor) {
		const prevPosition = cursor.x;
		const currentCell = cursor.getCell();
		const prevAttrs = currentCell ? getBufferCellAttributes(currentCell) : '';

		const { amount, direction, moveByWords } = this;
		const delta = direction === CursorMoveDirection.Back ? -1 : 1;

		const target = cursor.clone();
		if (moveByWords) {
			for (let i = 0; i < amount; i++) {
				moveToWordBoundary(buffer, target, delta);
			}
		} else {
			target.shift(delta * amount);
		}

		this.applied = {
			amount: Math.abs(cursor.x - target.x),
			prevPosition,
			prevAttrs,
			rollForward: cursor.moveTo(target),
		};

		return this.applied.rollForward;
	}

	public rollback(cursor: Cursor) {
		if (!this.applied) {
			return '';
		}

		return cursor.move(this.applied.prevPosition, cursor.y) + this.applied.prevAttrs;
	}

	public rollForwards() {
		return ''; // does not need to rewrite
	}

	public matches(input: StringReader) {
		if (!this.applied) {
			return MatchResult.Failure;
		}

		const direction = this.direction;
		const { amount, rollForward } = this.applied;


		// arg can be omitted to move one character
		const r = input.eatGradually(`${CSI}${direction}`.repeat(amount));
		if (r !== MatchResult.Failure) {
			return r;
		}

		// \b is the equivalent to moving one character back
		if (direction === CursorMoveDirection.Back) {
			const r = input.eatGradually(`\b`.repeat(amount));
			if (r !== MatchResult.Failure) {
				return r;
			}
		}

		// check if the cursor position is set absolutely
		if (rollForward) {
			const r = input.eatGradually(rollForward);
			if (r !== MatchResult.Failure) {
				return r;
			}
		}

		// check for a relative move in the direction
		return input.eatGradually(`${CSI}${amount}${direction}`);
	}
}

export class PredictionStats extends Disposable {
	private readonly stats: [latency: number, correct: boolean][] = [];
	private index = 0;
	private readonly addedAtTime = new WeakMap<IPrediction, number>();
	private readonly changeEmitter = new Emitter<void>();
	public readonly onChange = this.changeEmitter.event;

	/**
	 * Gets the percent (0-1) of predictions that were accurate.
	 */
	public get accuracy() {
		let correctCount = 0;
		for (const [, correct] of this.stats) {
			if (correct) {
				correctCount++;
			}
		}

		return correctCount / (this.stats.length || 1);
	}

	/**
	 * Gets the number of recorded stats.
	 */
	public get sampleSize() {
		return this.stats.length;
	}

	/**
	 * Gets latency stats of successful predictions.
	 */
	public get latency() {
		const latencies = this.stats.filter(([, correct]) => correct).map(([s]) => s).sort();

		return {
			count: latencies.length,
			min: latencies[0],
			median: latencies[Math.floor(latencies.length / 2)],
			max: latencies[latencies.length - 1],
		};
	}

	constructor(timeline: PredictionTimeline) {
		super();
		this._register(timeline.onPredictionAdded(p => this.addedAtTime.set(p, Date.now())));
		this._register(timeline.onPredictionSucceeded(this.pushStat.bind(this, true)));
		this._register(timeline.onPredictionFailed(this.pushStat.bind(this, false)));
	}

	private pushStat(correct: boolean, prediction: IPrediction) {
		const started = this.addedAtTime.get(prediction)!;
		this.stats[this.index] = [Date.now() - started, correct];
		this.index = (this.index + 1) % statsBufferSize;
		this.changeEmitter.fire();
	}
}

export class PredictionTimeline {
	/**
	 * Expected queue of events. Only predictions for the lowest are
	 * written into the terminal.
	 */
	private expected: ({ gen: number; p: IPrediction })[] = [];

	/**
	 * Current prediction generation.
	 */
	private currentGen = 0;

	/**
	 * Cursor position -- kept outside the buffer since it can be ahead if
	 * typing swiftly.
	 */
	private cursor: Cursor | undefined;

	/**
	 * Previously sent data that was buffered and should be prepended to the
	 * next input.
	 */
	private inputBuffer?: string;

	/**
	 * Whether predictions are echoed to the terminal. If false, predictions
	 * will still be computed internally for latency metrics, but input will
	 * never be adjusted.
	 */
	private showPredictions = false;

	private readonly addedEmitter = new Emitter<IPrediction>();
	public readonly onPredictionAdded = this.addedEmitter.event;
	private readonly failedEmitter = new Emitter<IPrediction>();
	public readonly onPredictionFailed = this.failedEmitter.event;
	private readonly succeededEmitter = new Emitter<IPrediction>();
	public readonly onPredictionSucceeded = this.succeededEmitter.event;

	constructor(public readonly terminal: Terminal) { }

	public setShowPredictions(show: boolean) {
		if (show === this.showPredictions) {
			return;
		}

		// console.log('set predictions:', show);
		this.showPredictions = show;

		const buffer = this.getActiveBuffer();
		if (!buffer) {
			return;
		}

		const toApply = this.expected.filter(({ gen }) => gen === this.expected[0].gen).map(({ p }) => p);
		if (show) {
			this.cursor = undefined;
			this.terminal.write(toApply.map(p => p.apply(buffer, this.getCursor(buffer))).join(''));
		} else {
			this.terminal.write(toApply.reverse().map(p => p.rollback(this.getCursor(buffer))).join(''));
		}
	}

	/**
	 * Should be called when input is incoming to the temrinal.
	 */
	public beforeServerInput(input: string): string {
		if (this.inputBuffer) {
			input = this.inputBuffer + input;
			this.inputBuffer = undefined;
		}

		if (!this.expected.length) {
			this.cursor = undefined;
			return input;
		}

		const buffer = this.getActiveBuffer();
		if (!buffer) {
			this.cursor = undefined;
			return input;
		}

		let output = '';

		const reader = new StringReader(input);
		const startingGen = this.expected[0].gen;
		const emitPredictionOmitted = () => {
			const omit = reader.eatRe(PREDICTION_OMIT_RE);
			if (omit) {
				output += omit[0];
			}
		};

		ReadLoop: while (this.expected.length && reader.remaining > 0) {
			emitPredictionOmitted();

			const prediction = this.expected[0].p;
			const cursor = this.getCursor(buffer);
			let beforeTestReaderIndex = reader.index;
			switch (prediction.matches(reader)) {
				case MatchResult.Success:
					// if the input character matches what the next prediction expected, undo
					// the prediction and write the real character out.
					const eaten = input.slice(beforeTestReaderIndex, reader.index);
					output += prediction.rollForwards?.(cursor, eaten);
					this.succeededEmitter.fire(prediction);
					this.expected.shift();
					break;
				case MatchResult.Buffer:
					// on a buffer, store the remaining data and completely read data
					// to be output as normal.
					this.inputBuffer = input.slice(beforeTestReaderIndex);
					reader.index = input.length;
					break ReadLoop;
				case MatchResult.Failure:
					// on a failure, roll back all remaining items in this generation
					// and clear predictions, since they are no longer valid
					output += this.expected.filter(p => p.gen === startingGen)
						.reverse()
						.map(({ p }) => p.rollback(this.getCursor(buffer)))
						.join('');
					this.expected = [];
					this.cursor = undefined;
					this.failedEmitter.fire(prediction);
					break ReadLoop;
			}
		}

		emitPredictionOmitted();

		// Extra data (like the result of running a command) should cause us to
		// reset the cursor
		if (!reader.eof) {
			output += reader.rest;
			this.expected = [];
			this.cursor = undefined;
		}

		// If we passed a generation boundary, apply the current generation's predictions
		if (this.expected.length && startingGen !== this.expected[0].gen) {
			for (const { p, gen } of this.expected) {
				if (gen !== this.expected[0].gen) {
					break;
				}

				output += p.apply(buffer, this.getCursor(buffer));
			}
		}

		if (!this.showPredictions) {
			return input;
		}

		if (output.length === 0 || output === input) {
			return output;
		}

		if (this.cursor) {
			output += this.cursor.moveInstruction();
		}

		// prevent cursor flickering while typing
		output = HIDE_CURSOR + output + SHOW_CURSOR;

		return output;
	}

	/**
	 * Appends a typeahead prediction.
	 */
	public addPrediction(buffer: IBuffer, prediction: IPrediction) {
		this.expected.push({ gen: this.currentGen, p: prediction });
		this.addedEmitter.fire(prediction);

		if (this.currentGen === this.expected[0].gen) {
			const text = prediction.apply(buffer, this.getCursor(buffer));
			if (this.showPredictions) {
				// console.log('predict:', JSON.stringify(text));
				this.terminal.write(text);
			}

			return true;
		}

		return false;
	}

	/**
	 * Appends a prediction followed by a boundary. The predictions applied
	 * after this one will only be displayed after the give prediction matches
	 * pty output/
	 */
	public addBoundary(buffer: IBuffer, prediction: IPrediction) {
		this.addPrediction(buffer, prediction);
		this.currentGen++;
	}

	public getCursor(buffer: IBuffer) {
		if (!this.cursor) {
			this.cursor = new Cursor(this.terminal.rows, this.terminal.cols, buffer);
		}

		return this.cursor;
	}

	public clearCursor() {
		this.cursor = undefined;
	}

	private getActiveBuffer() {
		const buffer = this.terminal.buffer.active;
		return buffer.type === 'normal' ? buffer : undefined;
	}
}
/**
 * Gets the escape sequence to restore state/appearence in the cell.
 */
const getBufferCellAttributes = (cell: IBufferCell) => cell.isAttributeDefault()
	? `${CSI}0m`
	: [
		cell.isBold() && `${CSI}1m`,
		cell.isDim() && `${CSI}2m`,
		cell.isItalic() && `${CSI}3m`,
		cell.isUnderline() && `${CSI}4m`,
		cell.isBlink() && `${CSI}5m`,
		cell.isInverse() && `${CSI}7m`,
		cell.isInvisible() && `${CSI}8m`,

		cell.isFgRGB() && `${CSI}38;2;${cell.getFgColor() >>> 24};${(cell.getFgColor() >>> 16) & 0xFF};${cell.getFgColor() & 0xFF}m`,
		cell.isFgPalette() && `${CSI}38;5;${cell.getFgColor()}m`,
		cell.isFgDefault() && `${CSI}39m`,

		cell.isBgRGB() && `${CSI}48;2;${cell.getBgColor() >>> 24};${(cell.getBgColor() >>> 16) & 0xFF};${cell.getBgColor() & 0xFF}m`,
		cell.isBgPalette() && `${CSI}48;5;${cell.getBgColor()}m`,
		cell.isBgDefault() && `${CSI}49m`,
	].filter(seq => !!seq).join('');

const parseTypeheadStyle = (style: string | number) => {
	if (typeof style === 'number') {
		return `${CSI}${style}m`;
	}

	const { r, g, b } = Color.fromHex(style).rgba;
	return `${CSI}32;${r};${g};${b}m`;
};

export class TypeAheadAddon extends Disposable implements ITerminalAddon {
	private typeheadStyle = parseTypeheadStyle(this.config.config.typeaheadStyle);
	private typeaheadThreshold = this.config.config.typeaheadThreshold;
	private lastRow?: { y: number; startingX: number };
	private timeline?: PredictionTimeline;
	public stats?: PredictionStats;

	constructor(
		private readonly processManager: ITerminalProcessManager,
		private readonly config: TerminalConfigHelper,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
	) {
		super();
	}

	public activate(terminal: Terminal): void {
		const timeline = this.timeline = new PredictionTimeline(terminal);
		const stats = this.stats = this._register(new PredictionStats(this.timeline));

		timeline.setShowPredictions(this.typeaheadThreshold === 0);
		this._register(terminal.onData(e => this.onUserData(e)));
		this._register(terminal.onResize(() => timeline.clearCursor()));
		this._register(this.config.onConfigChanged(() => {
			this.typeheadStyle = parseTypeheadStyle(this.config.config.typeaheadStyle);
			this.typeaheadThreshold = this.config.config.typeaheadThreshold;
			this.reevaluatePredictorState(stats, timeline);
		}));
		this._register(this.processManager.onBeforeProcessData(e => this.onBeforeProcessData(e)));

		let nextStatsSend: any;
		this._register(stats.onChange(() => {
			if (!nextStatsSend) {
				nextStatsSend = setTimeout(() => {
					this.sendLatencyStats(stats);
					nextStatsSend = undefined;
				}, statsSendTelemetryEvery);
			}

			this.reevaluatePredictorState(stats, timeline);
		}));
	}

	/**
	 * Note on debounce:
	 *
	 * We want to toggle the state only when the user has a pause in their
	 * typing. Otherwise, we could turn this on when the PTY sent data but the
	 * terminal cursor is not updated, causes issues.
	 */
	@debounce(100)
	private reevaluatePredictorState(stats: PredictionStats, timeline: PredictionTimeline) {
		if (this.typeaheadThreshold < 0) {
			timeline.setShowPredictions(false);
		} else if (this.typeaheadThreshold === 0) {
			timeline.setShowPredictions(true);
		} else if (stats.sampleSize > statsMinSamplesToTurnOn && stats.accuracy > statsMinAccuracyToTurnOn) {
			const latency = stats.latency.median;
			if (latency >= this.typeaheadThreshold) {
				timeline.setShowPredictions(true);
			} else if (latency < this.typeaheadThreshold / statsToggleOffThreshold) {
				timeline.setShowPredictions(false);
			}
		}
	}

	private sendLatencyStats(stats: PredictionStats) {
		/* __GDPR__
			"terminalLatencyStats" : {
				"min" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"max" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"median" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"count" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true },
				"predictionAccuracy" : { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true }
			}
		 */
		this.telemetryService.publicLog('terminalLatencyStats', {
			...stats.latency,
			predictionAccuracy: stats.accuracy,
		});
	}

	private onUserData(data: string): void {
		if (this.timeline?.terminal.buffer.active.type !== 'normal') {
			return;
		}

		// console.log('user data:', JSON.stringify(data));

		const terminal = this.timeline.terminal;
		const buffer = terminal.buffer.active;

		// the following code guards the terminal prompt to avoid being able to
		// arrow or backspace-into the prompt. Record the lowest X value at which
		// the user gave input, and mark all additions before that as tentative.
		const actualY = buffer.baseY + buffer.cursorY;
		if (actualY !== this.lastRow?.y) {
			this.lastRow = { y: actualY, startingX: buffer.cursorX };
		} else {
			this.lastRow.startingX = Math.min(this.lastRow.startingX, buffer.cursorX);
		}

		const addLeftNavigating = (p: IPrediction) =>
			this.timeline!.getCursor(buffer).x <= this.lastRow!.startingX
				? this.timeline!.addBoundary(buffer, new TentativeBoundary(p))
				: this.timeline!.addPrediction(buffer, p);

		/** @see https://github.com/xtermjs/xterm.js/blob/1913e9512c048e3cf56bb5f5df51bfff6899c184/src/common/input/Keyboard.ts */
		const reader = new StringReader(data);
		while (reader.remaining > 0) {
			if (reader.eatCharCode(127)) { // backspace
				addLeftNavigating(new BackspacePrediction());
				continue;
			}

			if (reader.eatCharCode(32, 126)) { // alphanum
				const char = data[reader.index - 1];
				if (this.timeline.addPrediction(buffer, new CharacterPrediction(this.typeheadStyle, char)) && this.timeline.getCursor(buffer).x === terminal.cols) {
					this.timeline.addBoundary(buffer, new TentativeBoundary(new LinewrapPrediction()));
				}
				continue;
			}

			const cursorMv = reader.eatRe(CSI_MOVE_RE);
			if (cursorMv) {
				const direction = cursorMv[3] as CursorMoveDirection;
				const p = new CursorMovePrediction(direction, !!cursorMv[2], Number(cursorMv[1]) || 1);
				if (direction === CursorMoveDirection.Back) {
					addLeftNavigating(p);
				} else {
					this.timeline.addPrediction(buffer, p);
				}
				continue;
			}

			if (reader.eatStr(`${ESC}f`)) {
				this.timeline.addPrediction(buffer, new CursorMovePrediction(CursorMoveDirection.Forwards, true, 1));
				continue;
			}

			if (reader.eatStr(`${ESC}b`)) {
				addLeftNavigating(new CursorMovePrediction(CursorMoveDirection.Back, true, 1));
				continue;
			}

			if (reader.eatChar('\r') && buffer.cursorY < terminal.rows - 1) {
				this.timeline.addPrediction(buffer, new NewlinePrediction());
				continue;
			}

			// something else
			this.timeline.addBoundary(buffer, new HardBoundary());
			break;
		}
	}

	private onBeforeProcessData(event: IBeforeProcessDataEvent): void {
		if (!this.timeline) {
			return;
		}

		// console.log('incoming data:', JSON.stringify(event.data));
		event.data = this.timeline.beforeServerInput(event.data);
		// console.log('emitted data:', JSON.stringify(event.data));

		// If there's something that looks like a password prompt, omit giving
		// input. This is approximate since there's no TTY "password here" code,
		// but should be enough to cover common cases like sudo
		if (PASSWORD_INPUT_RE.test(event.data)) {
			const terminal = this.timeline.terminal;
			this.timeline.addBoundary(terminal.buffer.active, new HardBoundary());
		}
	}
}
