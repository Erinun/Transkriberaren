"""
Talarseparering med diarize-biblioteket.

Använder diarize (FoxNoseTech, Apache 2.0) för att identifiera
vem som pratar när i en ljudfil. Baseras på Silero VAD +
WeSpeaker ONNX-embeddings + spektral klustring. Kräver ingen
HuggingFace-token.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

# Module-level warmup flag
_models_warmed_up = False


@dataclass
class SpeakerSegment:
    """Ett tidssegment med identifierad talare."""
    start: float
    end: float
    speaker_id: str
    speaker_label: str


@dataclass
class DiarizationResult:
    """Resultat från talarseparering."""
    segments: list[SpeakerSegment]
    num_speakers: int
    processing_time: float
    speakers_merged: int = 0


def _warmup_models():
    """Säkerställ att diarize-modellerna (Silero VAD + WeSpeaker) är nedladdade."""
    global _models_warmed_up
    if _models_warmed_up:
        return
    from silero_vad import load_silero_vad
    import wespeakerruntime as wespeaker_rt
    load_silero_vad()
    wespeaker_rt.Speaker(lang="en")
    _models_warmed_up = True


def _merge_segments(
    segments: list[SpeakerSegment],
    max_gap: float = 1.5,
) -> list[SpeakerSegment]:
    """
    Merga korta konsekutiva segment från samma talare.

    Om samma talare har flera segment med gap < max_gap sekunder
    emellan, slås de ihop till ett enda segment. Minskar fragmentering.
    """
    if not segments:
        return []

    merged: list[SpeakerSegment] = [SpeakerSegment(
        start=segments[0].start,
        end=segments[0].end,
        speaker_id=segments[0].speaker_id,
        speaker_label=segments[0].speaker_label,
    )]

    for seg in segments[1:]:
        prev = merged[-1]
        gap = seg.start - prev.end

        if seg.speaker_id == prev.speaker_id and gap < max_gap:
            # Förläng föregående segment
            prev.end = seg.end
        else:
            merged.append(SpeakerSegment(
                start=seg.start,
                end=seg.end,
                speaker_id=seg.speaker_id,
                speaker_label=seg.speaker_label,
            ))

    return merged


def _assign_labels(segments: list[SpeakerSegment]) -> list[SpeakerSegment]:
    """
    Mappa speaker-ID till läsbara etiketter (Talare 1, Talare 2, ...).

    Etiketter tilldelas i ordning av första uppträdande i inspelningen.
    """
    label_map: dict[str, str] = {}
    counter = 0

    for seg in segments:
        if seg.speaker_id not in label_map:
            counter += 1
            label_map[seg.speaker_id] = f"Talare {counter}"
        seg.speaker_label = label_map[seg.speaker_id]

    return segments


def _merge_similar_speakers(
    embeddings: np.ndarray,
    labels: np.ndarray,
    similarity_threshold: float = 0.55,
) -> np.ndarray:
    """Slå ihop talare vars röst-embeddings är för lika.

    Beräknar centroid per talare (medelvärde av L2-normaliserade embeddings),
    sedan pairwise cosine similarity. Talare med likhet >= threshold slås ihop.

    Args:
        embeddings: Speaker embeddings, shape (N, D).
        labels: Cluster-labels, shape (N,).
        similarity_threshold: Cosine similarity-tröskel för merge.

    Returns:
        Uppdaterad labels-array med sammanslagna talare.
    """
    from sklearn.preprocessing import normalize as l2_normalize
    from sklearn.metrics.pairwise import cosine_similarity

    unique_labels = np.unique(labels)
    if len(unique_labels) <= 1:
        return labels

    # L2-normalisera embeddings
    emb_norm = l2_normalize(embeddings, norm="l2")

    # Beräkna centroid per speaker
    centroids = {}
    for lbl in unique_labels:
        mask = labels == lbl
        centroids[int(lbl)] = emb_norm[mask].mean(axis=0)

    centroid_labels = sorted(centroids.keys())
    centroid_matrix = np.array([centroids[lbl] for lbl in centroid_labels])

    # Pairwise cosine similarity mellan centroids
    sim_matrix = cosine_similarity(centroid_matrix)

    # Union-Find för merge
    parent = {lbl: lbl for lbl in centroid_labels}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            # Behåll den med lägst index (dvs den som dök upp först)
            if ra < rb:
                parent[rb] = ra
            else:
                parent[ra] = rb

    # Merga par med hög likhet
    merged_any = False
    for i in range(len(centroid_labels)):
        for j in range(i + 1, len(centroid_labels)):
            if sim_matrix[i, j] >= similarity_threshold:
                li, lj = centroid_labels[i], centroid_labels[j]
                if find(li) != find(lj):
                    logger.info(
                        "Slår ihop talare %d och %d (cosine similarity=%.3f >= %.3f)",
                        li, lj, sim_matrix[i, j], similarity_threshold,
                    )
                    union(li, lj)
                    merged_any = True

    if not merged_any:
        return labels

    # Applicera merge på labels
    new_labels = labels.copy()
    for i, lbl in enumerate(labels):
        new_labels[i] = find(int(lbl))

    # Renumrera till 0, 1, 2, ... i ordning
    unique_new = sorted(set(new_labels))
    remap = {old: new for new, old in enumerate(unique_new)}
    for i in range(len(new_labels)):
        new_labels[i] = remap[new_labels[i]]

    original_count = len(unique_labels)
    new_count = len(unique_new)
    logger.info(
        "Speaker merge: %d → %d talare",
        original_count, new_count,
    )

    return new_labels


def diarize(
    audio_path: Path | str,
    num_speakers: int | None = None,
    min_speakers: int = 1,
    max_speakers: int = 10,
    merge_gap: float = 1.5,
    similarity_threshold: float = 0.55,
) -> DiarizationResult:
    """
    Kör talarseparering på en ljudfil.

    Args:
        audio_path: Sökväg till ljudfil (WAV rekommenderas).
        num_speakers: Exakt antal talare (None = auto-detect).
        min_speakers: Minsta antal talare vid auto-detect.
        max_speakers: Maximalt antal talare vid auto-detect.
        merge_gap: Max gap i sekunder för att merga segment från samma talare.
        similarity_threshold: Cosine similarity-tröskel för att slå ihop liknande talare.

    Returns:
        DiarizationResult med talarsegment och metadata.
    """
    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Ljudfilen finns inte: {audio_path}")

    logger.info("Startar diarisering av: %s", audio_path.name)
    start_time = time.perf_counter()

    speakers_merged = 0

    try:
        # Anropa bibliotekets interna pipeline-steg direkt för att
        # få tillgång till embeddings (behövs för speaker merge)
        from diarize.vad import run_vad
        from diarize.embeddings import extract_embeddings
        from diarize.clustering import cluster_speakers
        from diarize import _build_diarization_segments

        # 1. VAD
        speech_segments = run_vad(str(audio_path))
        if not speech_segments:
            logger.warning("Inget tal detekterat i %s", audio_path)
            elapsed = time.perf_counter() - start_time
            return DiarizationResult(
                segments=[], num_speakers=0, processing_time=elapsed,
            )

        # 2. Extrahera embeddings
        embeddings, subsegments = extract_embeddings(str(audio_path), speech_segments)
        if len(embeddings) == 0:
            logger.warning("Kunde inte extrahera embeddings från %s", audio_path)
            elapsed = time.perf_counter() - start_time
            return DiarizationResult(
                segments=[], num_speakers=0, processing_time=elapsed,
            )

        # 3. Klustring
        kwargs_cluster: dict = {}
        if num_speakers is not None:
            kwargs_cluster["num_speakers"] = num_speakers
        else:
            kwargs_cluster["min_speakers"] = min_speakers
            kwargs_cluster["max_speakers"] = max_speakers

        labels, estimation_details = cluster_speakers(embeddings, **kwargs_cluster)

        # Logga diagnostikinfo
        if estimation_details:
            logger.info(
                "Talaruppskattning: metod=%s, best_k=%d, cosine_sim_p10=%s, reason=%s",
                estimation_details.method, estimation_details.best_k,
                f"{estimation_details.cosine_sim_p10:.3f}" if estimation_details.cosine_sim_p10 is not None else "N/A",
                estimation_details.reason or "auto",
            )
            if estimation_details.k_bics:
                logger.debug("BIC-värden per k: %s", estimation_details.k_bics)

        # 4. Slå ihop liknande talare (bara vid auto-detect)
        if num_speakers is None:
            original_count = len(np.unique(labels))
            labels = _merge_similar_speakers(embeddings, labels, similarity_threshold)
            new_count = len(np.unique(labels))
            speakers_merged = original_count - new_count

        # 5. Bygg segment
        lib_segments = _build_diarization_segments(speech_segments, subsegments, labels)

    except Exception:
        logger.warning(
            "Direkt pipeline-anrop misslyckades, faller tillbaka till diarize()",
            exc_info=True,
        )
        # Fallback: använd högnivå-API (utan speaker merge)
        from diarize import diarize as _lib_diarize
        kwargs: dict = {"audio_path": str(audio_path)}
        if num_speakers is not None:
            kwargs["num_speakers"] = num_speakers
        else:
            kwargs["min_speakers"] = min_speakers
            kwargs["max_speakers"] = max_speakers

        result = _lib_diarize(**kwargs)
        lib_segments = result.segments

    # Konvertera till SpeakerSegment-lista
    raw_segments: list[SpeakerSegment] = []
    for seg in lib_segments:
        raw_segments.append(SpeakerSegment(
            start=seg.start,
            end=seg.end,
            speaker_id=seg.speaker,
            speaker_label="",  # Tilldelas nedan
        ))

    # Sortera efter starttid
    raw_segments.sort(key=lambda s: s.start)

    # Tilldela läsbara etiketter
    _assign_labels(raw_segments)

    # Merga korta konsekutiva segment från samma talare
    merged = _merge_segments(raw_segments, max_gap=merge_gap)

    elapsed = time.perf_counter() - start_time

    # Räkna unika talare
    unique_speakers = len({s.speaker_id for s in merged})

    logger.info(
        "Diarisering klar: %d segment, %d talare, %.1f sek",
        len(merged), unique_speakers, elapsed,
    )

    return DiarizationResult(
        segments=merged,
        num_speakers=unique_speakers,
        processing_time=elapsed,
        speakers_merged=speakers_merged,
    )
