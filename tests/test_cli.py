"""Tester för CLI-modulen."""

from click.testing import CliRunner

from motesskribent.cli import main


class TestCLI:
    """CLI-tester med CliRunner — kräver inga modeller."""

    def test_help(self):
        runner = CliRunner()
        result = runner.invoke(main, ["--help"])
        assert result.exit_code == 0
        assert "MötesSkribent" in result.output

    def test_transkribera_help(self):
        runner = CliRunner()
        result = runner.invoke(main, ["transkribera", "--help"])
        assert result.exit_code == 0
        assert "audio_file" in result.output.lower() or "AUDIO_FILE" in result.output

    def test_transkribera_missing_file(self):
        runner = CliRunner()
        result = runner.invoke(main, ["transkribera", "nonexistent.wav"])
        assert result.exit_code != 0

    def test_modeller_command(self):
        runner = CliRunner()
        result = runner.invoke(main, ["modeller"])
        assert result.exit_code == 0
        assert "kb-whisper" in result.output.lower()

    def test_info_command(self):
        runner = CliRunner()
        result = runner.invoke(main, ["info"])
        assert result.exit_code == 0
        assert "CPU" in result.output or "cpu" in result.output.lower()

    def test_version(self):
        runner = CliRunner()
        result = runner.invoke(main, ["--version"])
        assert result.exit_code == 0
        assert "0.1.0" in result.output
