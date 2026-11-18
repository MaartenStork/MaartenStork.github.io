/* ------------------------------------------------------------------
   YOUR CONTENT LIVES HERE.

   Each planet = one section. Order matters (it decides where the
   planet sits in space and its number). Up to 6 planets.

   type: the planet's look
     'terra' : blue/green world with clouds
     'gas'   : banded gas giant (add rings: true)
     'ice'   : pale ice world
     'lava'  : dark world with glowing cracks
     'moon'  : violet cratered moon
------------------------------------------------------------------- */

window.PORTFOLIO = {
  name: 'Maarten Stork',
  role: 'PhD candidate / scientific ML / TU Delft',

  // the big caption on the home screen
  intro: {
    title: 'Maarten Stork',
    subtitle: 'PhD candidate / Scientific ML / TU Delft',
    text: '',
    hint: '> pick a planet to explore',
  },

  planets: [
    {
      id: 'about',
      hint: "who I am",
      label: 'About',
      type: 'terra',
      html: `
        <p class="lead">Hi, I'm Maarten.</p>
        <p>I'm a PhD candidate at TU Delft, in the Pattern Recognition &amp;
        Bioinformatics group, working on scientific machine learning and
        foundation models: new methods building on physics-informed neural
        networks, neural operators and transformer-based PDE models.</p>
        <p>Before that I did an MSc in Computational Science at the University
        of Amsterdam (cum laude) and a BSc in Artificial Intelligence at the VU.
        Along the way I evolved 3D-printable robots and co-founded an LLM startup.</p>
        <p>Former Dutch U19 national team rower. I grew up between the
        Netherlands and New Zealand.</p>
        <ul class="links">
          <li><span class="m">speaks</span><span>Dutch, English, German</span></li>
          <li><span class="m">tools</span><span>Python, PyTorch, NumPy, SciPy, MuJoCo, ROS 2, C#, TypeScript, Docker</span></li>
        </ul>
        <p class="dim">This site is a real-time 3D scene, redrawn as text
        characters about sixty times a second.</p>
      `,
    },
    {
      id: 'research',
      hint: "papers & projects",
      label: 'Research',
      type: 'gas',
      rings: true,
      html: `
        <p class="kicker">Publications</p>
        <ul class="list">
          <li>
            <div class="row"><span class="t">Designing Intelligent Nanoparticles: A Physics-Informed Evolutionary Framework for Controlled Cellular Uptake</span><span class="m">in prep.</span></div>
            <p>Stork &amp; Ilie. Oral presentation at NWO Biophysics 2026.</p>
            <figure class="holo-media float"><img src="media/nanoparticles.webp" alt="Evolved nanoparticle designs MP60, MP48, MPC52 and MPCUBE" loading="lazy"></figure>
          </li>
          <li>
            <a href="https://doi.org/10.1145/3712255.3726713" target="_blank" rel="noopener"><span class="t">Size Matters; Variable-Length Bones in Evolvable Modular Robots</span><span class="m">GECCO '25</span></a>
            <p>Stork, de Regt, Nguyen &amp; Eiben. Genetic and Evolutionary
            Computation Conference Companion, M&aacute;laga. ACM.
            Presented in person.</p>
            <figure class="holo-media float robot"><img src="media/gecco-robot.webp" alt="An evolved modular robot with variable-length bones" loading="lazy"></figure>
          </li>
        </ul>
        <p class="kicker">Current research</p>
        <ul class="list">
          <li>
            <div class="row"><span class="t">Foundation models for PDEs</span><span class="m">PhD / TU Delft</span></div>
            <p>Building on physics-informed neural networks, neural operators
            and transformer-based PDE models.</p>
          </li>
        </ul>
      `,
    },
    {
      id: 'experience',
      hint: "where I've worked",
      label: 'Experience',
      type: 'lava',
      html: `
        <ul class="list">
          <li data-logo="tudelft">
            <div class="row"><span class="t">PhD Candidate</span><span class="m">2026 &ndash; now</span></div>
            <div class="sub">TU Delft / Pattern Recognition &amp; Bioinformatics</div>
            <p>Scientific machine learning and foundation models.
            Supervised by Dr. Jing Sun and Dr. David Tax.</p>
          </li>
          <li data-logo="ebrain">
            <div class="row"><span class="t">Co-Founder</span><span class="m">2025</span></div>
            <div class="sub">eBrain B.V. / Amsterdam &amp; Utrecht</div>
            <p>Built a platform that lets small businesses use LLMs on their own
            data, from prototype to production. Stepped back to pursue research
            after a successful investment round.</p>
          </li>
          <li data-logo="zonnegilde">
            <div class="row"><span class="t">Data Scientist</span><span class="m">2024 &ndash; 2025</span></div>
            <div class="sub">Zonnegilde / Kampen</div>
            <p>Lead-generation models and energy-consumption forecasting,
            deployed on real-world solar panel systems.</p>
          </li>
          <li data-logo="uva">
            <div class="row"><span class="t">Student Researcher, Evolvable Robotics</span><span class="m">2024 &ndash; 2025</span></div>
            <div class="sub">UvA &amp; VU / Evolutionary Computing, Prof. Eiben</div>
            <p>Evolved 3D-printable, adaptive robot structures. Results
            published at GECCO.</p>
          </li>
          <li data-logo="loyens">
            <div class="row"><span class="t">AI Full-Stack Developer</span><span class="m">2024</span></div>
            <div class="sub">Loyens &amp; Loeff / Amsterdam</div>
            <p>ML tooling for the technology &amp; innovation team: generative
            chatbot optimisation, AI-powered web apps.</p>
          </li>
          <li data-logo="vu">
            <div class="row"><span class="t">Teaching Assistant &amp; Mentor</span><span class="m">2021 &ndash; 2023</span></div>
            <div class="sub">Vrije Universiteit Amsterdam</div>
            <p>AI courses including Socially Aware Computing and AI &amp; Law.
            Introduction mentor for new students.</p>
          </li>
        </ul>
      `,
    },
    {
      id: 'education',
      hint: "studies & degrees",
      label: 'Education',
      type: 'ice',
      html: `
        <ul class="list">
          <li data-logo="uva">
            <div class="row"><span class="t">MSc Computational Science</span><span class="m">2024 &ndash; 2026</span></div>
            <div class="sub">Universiteit van Amsterdam / cum laude, GPA 8.5</div>
            <p>Thesis on evolutionary, physics-informed design of nanoparticles
            for controlled cellular uptake, with Dr. Ioana Ilie (8.5).
            Student ambassador for my cohort.</p>
          </li>
          <li data-logo="vu">
            <div class="row"><span class="t">BSc Artificial Intelligence</span><span class="m">2020 &ndash; 2023</span></div>
            <div class="sub">Vrije Universiteit Amsterdam</div>
            <p>Thesis on brain-computer interface datasets, with Dr. Michel Klein
            and Dr. Charlotte Gerritsen (8.5). Completed while competing on the
            Dutch national rowing team.</p>
          </li>
        </ul>
      `,
    },
    {
      id: 'contact',
      hint: "get in touch",
      label: 'Contact',
      type: 'moon',
      html: `
        <p>Get in touch about research, collaborations or anything else.</p>
        <ul class="links">
          <li><span class="m">mail</span><a href="mailto:maartenastork@gmail.com">maartenastork@gmail.com</a></li>
          <li><span class="m">github</span><a href="https://github.com/MaartenStork" target="_blank" rel="noopener">github.com/MaartenStork</a></li>
          <li><span class="m">linkedin</span><a href="https://www.linkedin.com/in/maarten-stork-54597222a" target="_blank" rel="noopener">linkedin.com/in/maarten-stork</a></li>
          <li><span class="m">at</span><span>TU Delft, the Netherlands</span></li>
        </ul>
      `,
    },
  ],
};
