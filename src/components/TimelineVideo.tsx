import { portfolioVideos } from '../lib/portfolioVideos';
import PortfolioVideoCard from './PortfolioVideoCard';
import { PortfolioVideoMuteProvider } from './PortfolioVideoMuteContext';

const featuredVideos = portfolioVideos.slice(0, 3);

export default function TimelineVideo() {
  return (
    <PortfolioVideoMuteProvider>
      <section className="content-section timeline-video-section" aria-labelledby="timeline-video-heading">
        <div className="section-heading">
          <span className="eyebrow">IMAGE · VIDEO · MULTIMEDIA</span>
          <h2 id="timeline-video-heading">A space for what comes next.</h2>
          <p>Photo, video, and multimedia placeholders for ADALIGO's own stories.</p>
        </div>
        <ol className="portfolio-video-grid homepage-video-grid">
          {featuredVideos.map((video) => <PortfolioVideoCard video={video} key={video.id} />)}
        </ol>
        <a className="secondary-button timeline-all-videos" href="/timeline.html">
          See all media placeholders
        </a>
      </section>
    </PortfolioVideoMuteProvider>
  );
}
