declare type u8 = number
declare type u16 = number
declare type u32 = number
declare type u64 = bigint
declare type u128 = bigint
declare type usize = bigint
declare type i8 = number
declare type i16 = number
declare type i32 = number
declare type i64 = bigint
declare type i128 = bigint
declare type isize = bigint
declare type NonZeroU8 = number
declare type NonZeroU16 = number
declare type NonZeroU32 = number
declare type NonZeroU64 = bigint
declare type NonZeroU128 = bigint
declare type NonZeroUsize = bigint
declare type NonZeroI8 = number
declare type NonZeroI16 = number
declare type NonZeroI32 = number
declare type NonZeroI64 = bigint
declare type NonZeroI128 = bigint
declare type NonZeroIsize = bigint
declare type f32 = number
declare type f64 = number

declare type ArrayLengthMutationKeys = "splice" | "push" | "pop" | "shift" | "unshift"
declare type FixedLengthArray<T, L extends number, TObj = [T, ...Array<T>]> =
    Pick<TObj, Exclude<keyof TObj, ArrayLengthMutationKeys>>
    & {
        readonly length: L
        [ I : number ] : T
        [Symbol.iterator]: () => IterableIterator<T>
    }

export namespace latch {
    export type TakeoverMode = { tag: "Pickup" } | { tag: "Jump" } | { tag: "Scale" }
}
export type AppIcon = { tag: "Fader" } | { tag: "AdEnv" } | { tag: "Random" } | { tag: "Euclid" } | { tag: "Attenuate" } | { tag: "Die" } | { tag: "Quantize" } | { tag: "Sequence" } | { tag: "Note" } | { tag: "EnvFollower" } | { tag: "SoftRandom" } | { tag: "Sine" } | { tag: "NoteBox" } | { tag: "SequenceSquare" } | { tag: "NoteGrid" } | { tag: "KnobRound" } | { tag: "Stereo" }
export type AuxJackMode = { tag: "None" } | { tag: "ClockOut", value: ClockDivision } | { tag: "ResetOut" }
export type ClockConfig = { clock_src: ClockSrc, ext_ppqn: u8, reset_src: ResetSrc, internal_bpm: f32, swing_amount: i8 }
export type ClockDivision = { tag: "_1" } | { tag: "_2" } | { tag: "_4" } | { tag: "_6" } | { tag: "_8" } | { tag: "_12" } | { tag: "_24" } | { tag: "_96" } | { tag: "_192" } | { tag: "_384" }
export type ClockSrc = { tag: "None" } | { tag: "Atom" } | { tag: "Meteor" } | { tag: "Cube" } | { tag: "Internal" } | { tag: "MidiIn" } | { tag: "MidiUsb" }
export type Color = { tag: "White" } | { tag: "Yellow" } | { tag: "Orange" } | { tag: "Red" } | { tag: "Lime" } | { tag: "Green" } | { tag: "Cyan" } | { tag: "SkyBlue" } | { tag: "Blue" } | { tag: "Violet" } | { tag: "Pink" } | { tag: "PaleGreen" } | { tag: "Sand" } | { tag: "Rose" } | { tag: "Salmon" } | { tag: "LightBlue" } | { tag: "Custom", value: [u8, u8, u8] }
export type ConfigMsgIn = { tag: "Ping" } | { tag: "GetAllApps" } | { tag: "GetGlobalConfig" } | { tag: "SetGlobalConfig", value: GlobalConfig } | { tag: "GetLayout" } | { tag: "SetLayout", value: Layout } | { tag: "GetAllAppParams" } | { tag: "GetAppParams", value: { layout_id: u8 } } | { tag: "SetAppParams", value: { layout_id: u8, values: FixedLengthArray<Value | undefined, 17> } } | { tag: "FactoryReset" } | { tag: "GetVersion" } | { tag: "MeasureVoOct", value: { output_jack: u8, aux_input: u8, dac_counts: u16 } } | { tag: "SetVoOctOutput", value: { output_jack: u8, dac_counts: u16 } } | { tag: "ReleaseVoOctOutput", value: { output_jack: u8 } } | { tag: "HoldPerfMute" } | { tag: "ReleasePerfMute" }
export type ConfigMsgOut = { tag: "Pong" } | { tag: "BatchMsgStart", value: u64 } | { tag: "BatchMsgEnd" } | { tag: "GlobalConfig", value: GlobalConfig } | { tag: "Layout", value: Layout } | { tag: "AppConfig", value: [u8, u64, [u64, string, string, Color, AppIcon, Param[]]] } | { tag: "AppState", value: [u8, Value[]] } | { tag: "Version", value: { major: u8, minor: u8, patch: u8 } } | { tag: "VoOctFrequency", value: { freq_hz: f32 } } | { tag: "VoOctCalError" } | { tag: "VoOctOutputSet" }
export type Curve = { tag: "Linear" } | { tag: "Logarithmic" } | { tag: "Exponential" } | { tag: "Deadzone" }
export type CustomVoOctCurve = { counts_per_oct: u16 }
export type GlobalConfig = { aux: FixedLengthArray<AuxJackMode, 3>, clock: ClockConfig, i2c_mode: I2cMode, led_brightness: u8, midi: MidiConfig, quantizer: QuantizerConfig, takeover_mode: latch.TakeoverMode, custom_voct_curves: FixedLengthArray<CustomVoOctCurve, 4> }
export type I2cMode = { tag: "Calibration" } | { tag: "Leader" } | { tag: "Follower" }
export type Key = { tag: "Chromatic" } | { tag: "Ionian" } | { tag: "Dorian" } | { tag: "Phrygian" } | { tag: "Lydian" } | { tag: "Mixolydian" } | { tag: "Aeolian" } | { tag: "Locrian" } | { tag: "BluesMaj" } | { tag: "BluesMin" } | { tag: "PentatonicMaj" } | { tag: "PentatonicMin" } | { tag: "Folk" } | { tag: "Japanese" } | { tag: "Gamelan" } | { tag: "HungarianMin" } | { tag: "Off" }
export type Layout = [FixedLengthArray<[u8, u64, u8] | undefined, 16>]
export type MidiCc = [u16]
export type MidiChannel = [u8]
export type MidiConfig = { outs: FixedLengthArray<MidiOutConfig, 3> }
export type MidiIn = [FixedLengthArray<boolean, 2>]
export type MidiMode = { tag: "Note" } | { tag: "Cc" }
export type MidiNote = [u8]
export type MidiOut = [FixedLengthArray<boolean, 3>]
export type MidiOutConfig = { send_clock: boolean, send_transport: boolean, mode: MidiOutMode }
export type MidiOutMode = { tag: "None" } | { tag: "Local" } | { tag: "MidiThru", value: { sources: MidiIn } } | { tag: "MidiMerge", value: { sources: MidiIn } }
export type Note = { tag: "C" } | { tag: "CSharp" } | { tag: "D" } | { tag: "DSharp" } | { tag: "E" } | { tag: "F" } | { tag: "FSharp" } | { tag: "G" } | { tag: "GSharp" } | { tag: "A" } | { tag: "ASharp" } | { tag: "B" }
export type Param = { tag: "None" } | { tag: "i32", value: { name: string, min: i32, max: i32 } } | { tag: "f32", value: { name: string, min: f32, max: f32 } } | { tag: "bool", value: { name: string } } | { tag: "Enum", value: { name: string, variants: string[] } } | { tag: "Curve", value: { name: string, variants: Curve[] } } | { tag: "Waveform", value: { name: string, variants: Waveform[] } } | { tag: "Color", value: { name: string, variants: Color[] } } | { tag: "Range", value: { name: string, variants: Range[] } } | { tag: "Note", value: { name: string, variants: Note[] } } | { tag: "MidiCc", value: { name: string } } | { tag: "MidiChannel", value: { name: string } } | { tag: "MidiIn" } | { tag: "MidiMode" } | { tag: "MidiNote", value: { name: string } } | { tag: "MidiOut" } | { tag: "MidiNrpn" } | { tag: "VoltPerOct" }
export type QuantizerConfig = { key: Key, tonic: Note }
export type Range = { tag: "_0_10V" } | { tag: "_0_5V" } | { tag: "_Neg5_5V" }
export type ResetSrc = { tag: "None" } | { tag: "Atom" } | { tag: "Meteor" } | { tag: "Cube" }
export type Value = { tag: "i32", value: i32 } | { tag: "f32", value: f32 } | { tag: "bool", value: boolean } | { tag: "Enum", value: u64 } | { tag: "Curve", value: Curve } | { tag: "Waveform", value: Waveform } | { tag: "Color", value: Color } | { tag: "Range", value: Range } | { tag: "Note", value: Note } | { tag: "MidiCc", value: MidiCc } | { tag: "MidiChannel", value: MidiChannel } | { tag: "MidiIn", value: MidiIn } | { tag: "MidiMode", value: MidiMode } | { tag: "MidiNote", value: MidiNote } | { tag: "MidiOut", value: MidiOut } | { tag: "MidiNrpn", value: boolean } | { tag: "VoltPerOct", value: VoltPerOct }
export type VoltPerOct = { tag: "Standard" } | { tag: "Buchla" } | { tag: "Custom", value: u8 }
export type Waveform = { tag: "Triangle" } | { tag: "Saw" } | { tag: "SawInv" } | { tag: "Square" } | { tag: "Sine" }

export type Type = "AppIcon" | "AuxJackMode" | "ClockConfig" | "ClockDivision" | "ClockSrc" | "Color" | "ConfigMsgIn" | "ConfigMsgOut" | "Curve" | "CustomVoOctCurve" | "GlobalConfig" | "I2cMode" | "Key" | "Layout" | "MidiCc" | "MidiChannel" | "MidiConfig" | "MidiIn" | "MidiMode" | "MidiNote" | "MidiOut" | "MidiOutConfig" | "MidiOutMode" | "Note" | "Param" | "QuantizerConfig" | "Range" | "ResetSrc" | "latch.TakeoverMode" | "Value" | "VoltPerOct" | "Waveform"
declare type ValueType<T extends Type> = T extends "AppIcon" ? AppIcon : T extends "AuxJackMode" ? AuxJackMode : T extends "ClockConfig" ? ClockConfig : T extends "ClockDivision" ? ClockDivision : T extends "ClockSrc" ? ClockSrc : T extends "Color" ? Color : T extends "ConfigMsgIn" ? ConfigMsgIn : T extends "ConfigMsgOut" ? ConfigMsgOut : T extends "Curve" ? Curve : T extends "CustomVoOctCurve" ? CustomVoOctCurve : T extends "GlobalConfig" ? GlobalConfig : T extends "I2cMode" ? I2cMode : T extends "Key" ? Key : T extends "Layout" ? Layout : T extends "MidiCc" ? MidiCc : T extends "MidiChannel" ? MidiChannel : T extends "MidiConfig" ? MidiConfig : T extends "MidiIn" ? MidiIn : T extends "MidiMode" ? MidiMode : T extends "MidiNote" ? MidiNote : T extends "MidiOut" ? MidiOut : T extends "MidiOutConfig" ? MidiOutConfig : T extends "MidiOutMode" ? MidiOutMode : T extends "Note" ? Note : T extends "Param" ? Param : T extends "QuantizerConfig" ? QuantizerConfig : T extends "Range" ? Range : T extends "ResetSrc" ? ResetSrc : T extends "latch.TakeoverMode" ? latch.TakeoverMode : T extends "Value" ? Value : T extends "VoltPerOct" ? VoltPerOct : T extends "Waveform" ? Waveform : void

export function serialize<T extends Type>(type: T, value: ValueType<T>): Uint8Array

export interface Result<T extends Type> {
    value: ValueType<T>;
    bytes: Uint8Array;
}

export function deserialize<T extends Type>(type: T, bytes: Uint8Array): Result<T>
