interface Props {
  levels: number[];
}

export default function AudioLevelBars({ levels }: Props) {
  return (
    <div className="flex items-end justify-center gap-[3px] h-14 mt-1">
      {levels.map((level, i) => (
        <div
          key={i}
          className="audio-bar w-[5px] rounded-full"
          style={{ height: `${Math.max(6, level * 100)}%` }}
        />
      ))}
    </div>
  );
}
