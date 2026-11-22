import { portfolioVideos } from './lib/portfolioVideos';
import PortfolioVideoCard from './components/PortfolioVideoCard';
import { PortfolioVideoMuteProvider } from './components/PortfolioVideoMuteContext';

export default function TimelinePage() {
  return (
    <PortfolioVideoMuteProvider>
      <main id="main" className="page-main timeline-page" tabIndex={-1}>
        <section className="timeline-hero">
          <span className="eyebrow">THE GHOST WHO CREATED IT ALL</span>
          <h1>From zero <span className="gradient-text">to infinity</span></h1>
          <p>The timeline is ready for ADALIGO's own pictures, video stories, and multimedia.</p>
        </section>

        <section className="content-section portfolio-video-timeline" aria-labelledby="portfolio-video-heading">
          <div className="section-heading">
            <span className="eyebrow">MEDIA PLACEHOLDERS</span>
            <h2 id="portfolio-video-heading">The next chapter starts here.</h2>
            <p>Replace these placeholders with ADALIGO-approved media when it is ready.</p>
          </div>
          <ol className="portfolio-video-grid">
            {portfolioVideos.map((video) => <PortfolioVideoCard video={video} key={video.id} />)}
          </ol>
        </section>
      </main>
    </PortfolioVideoMuteProvider>
  );
}
