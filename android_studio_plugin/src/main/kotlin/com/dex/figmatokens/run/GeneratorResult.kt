package com.dex.figmatokens.run

/** Severity of a single line of generator output. */
enum class LogLevel { INFO, WARNING, ERROR, SYSTEM }

/** Sink for generator output, implemented by the tool window console. */
interface GeneratorLog {
    fun clear()
    fun append(line: String, level: LogLevel)

    fun info(line: String) = append(line, LogLevel.INFO)
    fun error(line: String) = append(line, LogLevel.ERROR)
    fun system(line: String) = append(line, LogLevel.SYSTEM)
}

/**
 * Classifies a generator output line. The CLI (and `npm` itself) don't use structured severity
 * prefixes, so this is deliberately coarse: stderr is treated as noteworthy (warning-or-worse),
 * stdout as plain info. Whether a run actually failed is decided by its exit code, not this.
 */
object LogLineClassifier {
    fun levelOf(line: String, fromStderr: Boolean): LogLevel =
        if (fromStderr) LogLevel.ERROR else LogLevel.INFO
}

/** Outcome of a generator run. */
sealed interface GeneratorResult {
    data class Success(
        val dryRun: Boolean,
        val warnings: List<String>,
        /** True when generation was skipped because tokens and settings were unchanged. */
        val upToDate: Boolean = false,
    ) : GeneratorResult
    data class Failure(val exitCode: Int, val message: String) : GeneratorResult
    data object Cancelled : GeneratorResult
}
